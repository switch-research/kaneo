import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import db from "../../../database";
import {
  activityTable,
  projectTable,
  taskTable,
} from "../../../database/schema";
import type { AgentHandle } from "../types";
import {
  getTaskSessionKey,
  isGatewayConfigured,
  sessionsHistory,
  sessionsSend,
} from "./gateway-client";
import {
  listThreadsToPoll,
  recordIngestOnce,
  updateThreadWatermark,
  upsertTaskThread,
} from "./session-manager";

function extractMentionHandles(markdown: string): string[] {
  const handles = new Set<string>();

  // BlockNote mentions are stored as markdown links: [@smoke](mention:smoke)
  const mentionHrefRe = /\bmention:([a-z0-9][a-z0-9_-]{0,31})\b/gi;
  for (;;) {
    const match = mentionHrefRe.exec(markdown);
    if (!match) break;
    if (match[1]) handles.add(match[1].toLowerCase());
  }

  const atRe = /(?:^|[^a-z0-9_])@([a-z0-9][a-z0-9_-]{0,31})\b/gi;
  for (;;) {
    const match = atRe.exec(markdown);
    if (!match) break;
    if (match[1]) handles.add(match[1].toLowerCase());
  }

  return Array.from(handles);
}

function toAgentHandles(handles: string[]): AgentHandle[] {
  const out: AgentHandle[] = [];
  for (const handle of handles) {
    const lowered = handle.toLowerCase();
    if (lowered === "shade" || lowered === "smoke" || lowered === "nav") {
      out.push(lowered);
    }
  }
  return out;
}

function joinAssistantText(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      chunks.push(block.text);
    }
  }
  return chunks.join("").trim();
}

type ParsedMarker =
  | { type: "comment"; text: string; index: number }
  | { type: "complete"; summary?: string; index: number }
  | { type: "blocked"; reason?: string; index: number };

function parseMarkers(text: string, taskId: string): ParsedMarker[] {
  const lines = text.split(/\r?\n/);
  const markers: ParsedMarker[] = [];

  const isMarkerLine = (line: string) =>
    /^TASK_(COMMENT|COMPLETE|BLOCKED):/i.test(line.trim());

  let markerIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    if (/^TASK_COMMENT:/i.test(line)) {
      const after = raw.split(/TASK_COMMENT:/i)[1] ?? "";
      let payload = after.trim();

      if (!payload) {
        // Capture following lines until next marker.
        const buf: string[] = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j] ?? "";
          if (isMarkerLine(next)) break;
          buf.push(next);
        }
        payload = buf.join("\n").trim();
      }

      if (payload) {
        markers.push({ type: "comment", text: payload, index: markerIndex });
        markerIndex += 1;
      }

      continue;
    }

    if (new RegExp(`^TASK_COMPLETE:${taskId}\\b`, "i").test(line)) {
      const after =
        raw.split(new RegExp(`TASK_COMPLETE:${taskId}`, "i"))[1] ?? "";
      const summary = after.trim() || undefined;
      markers.push({ type: "complete", summary, index: markerIndex });
      markerIndex += 1;
      continue;
    }

    if (new RegExp(`^TASK_BLOCKED:${taskId}\\b`, "i").test(line)) {
      const after =
        raw.split(new RegExp(`TASK_BLOCKED:${taskId}`, "i"))[1] ?? "";
      const reason = after.trim() || undefined;
      markers.push({ type: "blocked", reason, index: markerIndex });
      markerIndex += 1;
    }
  }

  return markers;
}

export async function routeMentionsFromComment(params: {
  taskId: string;
  projectId: string;
  rawComment: string;
  authorName: string;
}): Promise<void> {
  const handles = toAgentHandles(extractMentionHandles(params.rawComment));
  if (handles.length === 0) return;

  const [task] = await db
    .select({
      title: taskTable.title,
      number: taskTable.number,
      projectName: projectTable.name,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, params.taskId))
    .limit(1);

  if (!task) return;

  const publicUrl = process.env.KANEO_PUBLIC_URL || "https://void.tycho.ca";
  const taskUrl = `${publicUrl}/dashboard`; // placeholder; avoid broken deep links

  const snippet =
    params.rawComment.length > 1400
      ? `${params.rawComment.slice(0, 1400)}…`
      : params.rawComment;

  await Promise.allSettled(
    handles.map(async (handle) => {
      if (!isGatewayConfigured(handle)) return;

      const sessionKey = getTaskSessionKey(params.taskId);
      await upsertTaskThread({ taskId: params.taskId, handle, sessionKey });

      const message =
        `🧵 Comment on task: "${task.title}"\n` +
        `Task ID: ${params.taskId}\n` +
        `From: ${params.authorName}\n` +
        `Link: ${taskUrl}\n\n` +
        `${snippet}\n\n` +
        "---\n" +
        "Reply with a marker:\n" +
        "TASK_COMMENT: <your reply>\n" +
        `TASK_COMPLETE:${params.taskId}`;

      await sessionsSend({
        handle,
        sessionKey,
        message,
        timeoutSeconds: 0,
      });
    }),
  );
}

async function postExternalComment(params: {
  taskId: string;
  handle: AgentHandle;
  content: string;
}): Promise<void> {
  await db.insert(activityTable).values({
    id: createId(),
    taskId: params.taskId,
    type: "comment",
    userId: null,
    content: params.content,
    externalUserName: params.handle,
    externalSource: "openclaw",
  });
}

async function markTaskDone(params: { taskId: string }): Promise<void> {
  await db
    .update(taskTable)
    .set({ status: "done" })
    .where(eq(taskTable.id, params.taskId));
}

export async function pollReturnLoopOnce(): Promise<void> {
  const threads = await listThreadsToPoll(200);

  for (const thread of threads) {
    const handle = thread.handle as AgentHandle;
    const sessionKey = thread.sessionKey;

    if (!isGatewayConfigured(handle)) {
      continue;
    }

    const history = await sessionsHistory({
      handle,
      sessionKey,
      limit: 200,
    });

    const messages = Array.isArray(history.messages) ? history.messages : [];

    let maxTs = thread.watermarkTs;

    for (const msg of messages) {
      const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
      if (!ts || ts <= thread.watermarkTs) continue;

      if (ts > maxTs) maxTs = ts;

      if (msg.role !== "assistant") continue;

      const text = joinAssistantText(msg.content);
      if (!text) continue;

      const markers = parseMarkers(text, thread.taskId);
      if (markers.length === 0) continue;

      for (const marker of markers) {
        const markerType = marker.type;
        const markerIndex = marker.index;

        const ok = await recordIngestOnce({
          taskId: thread.taskId,
          handle,
          sessionKey,
          messageTs: ts,
          markerType,
          markerIndex,
        });

        if (!ok) continue;

        if (marker.type === "comment") {
          await postExternalComment({
            taskId: thread.taskId,
            handle,
            content: marker.text,
          });
          continue;
        }

        if (marker.type === "blocked") {
          const content = marker.reason
            ? `Blocked: ${marker.reason}`
            : "Blocked.";
          await postExternalComment({
            taskId: thread.taskId,
            handle,
            content,
          });
          continue;
        }

        if (marker.type === "complete") {
          await markTaskDone({ taskId: thread.taskId });
          const content = marker.summary
            ? `Completed: ${marker.summary}`
            : "Completed.";
          await postExternalComment({
            taskId: thread.taskId,
            handle,
            content,
          });
        }
      }
    }

    if (maxTs > thread.watermarkTs) {
      await updateThreadWatermark({ id: thread.id, watermarkTs: maxTs });
    }
  }
}

let pollerRunning = false;

export function startReturnLoopPoller(): void {
  if (pollerRunning) return;

  const enabled = process.env.OPENCLAW_POLLER_ENABLED !== "0";
  if (!enabled) {
    return;
  }

  const intervalMs = Number.parseInt(
    process.env.OPENCLAW_POLLER_INTERVAL_MS ?? "5000",
    10,
  );

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error("OPENCLAW_POLLER_INTERVAL_MS must be >= 1000");
  }

  pollerRunning = true;
  let inFlight = false;

  setInterval(() => {
    if (inFlight) return;
    inFlight = true;

    void pollReturnLoopOnce()
      .catch((err) => {
        console.error("[openclaw] poller error:", err);
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
}

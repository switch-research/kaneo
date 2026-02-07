/**
 * OpenClaw Gateway integration (Kaneo → OpenClaw)
 *
 * - Uses deterministic per-task sessions.
 * - Uses canonical sessionKey format so OpenClaw auto-creates the session on first send.
 *
 * Canonical task session key:
 *   agent:main:void:task:{taskId}
 */
import { config } from "dotenv-mono";

config();

type AgentHandle = "shade" | "smoke" | "nav";

const AGENT_HANDLES = new Set<AgentHandle>(["shade", "smoke", "nav"]);

export function isAgentHandle(handle: string): handle is AgentHandle {
  return AGENT_HANDLES.has(handle.toLowerCase() as AgentHandle);
}

export function getAgentHandles(handles: string[]): AgentHandle[] {
  const out: AgentHandle[] = [];
  for (const raw of handles) {
    const lowered = raw.toLowerCase();
    if (isAgentHandle(lowered)) out.push(lowered);
  }
  return out;
}

export function getTaskSessionKey(taskId: string): string {
  return `agent:main:void:task:${taskId}`;
}

const DEBUG_OPENCLAW = process.env.DEBUG_OPENCLAW === "1";
function debugLog(...args: unknown[]): void {
  if (DEBUG_OPENCLAW) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

function resolveGatewayEnv(handle: AgentHandle): {
  url: string;
  token: string;
} {
  const upper = handle.toUpperCase();

  // Per-handle overrides (preferred)
  const url =
    process.env[`OPENCLAW_GATEWAY_URL_${upper}`] ??
    process.env.OPENCLAW_GATEWAY_URL ??
    "";

  const token =
    process.env[`OPENCLAW_GATEWAY_TOKEN_${upper}`] ??
    process.env.OPENCLAW_GATEWAY_TOKEN ??
    "";

  return { url, token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function extractToolText(envelope: unknown): string | undefined {
  if (!isRecord(envelope)) return undefined;
  const result = envelope.result;
  if (!isRecord(result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;

  for (const chunk of content) {
    if (!isRecord(chunk)) continue;
    if (chunk.type === "text" && typeof chunk.text === "string") {
      return chunk.text;
    }
  }

  return undefined;
}

async function invokeOpenClawTool<T>(params: {
  handle: AgentHandle;
  tool: string;
  args: Record<string, unknown>;
}): Promise<T> {
  const { url, token } = resolveGatewayEnv(params.handle);

  if (!url || !token) {
    throw new Error(`OpenClaw gateway not configured for @${params.handle}`);
  }

  const res = await fetch(`${url}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tool: params.tool, args: params.args }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${params.tool} failed: ${res.status} ${text.slice(0, 300)}`,
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(
      `${params.tool} failed: non-JSON response: ${text.slice(0, 300)}`,
    );
  }

  // Treat HTTP 200 + { ok:false } as failure.
  if (isRecord(envelope) && envelope.ok === false) {
    const code =
      typeof envelope.errorCode === "string" ? envelope.errorCode : "";
    const msg =
      typeof envelope.errorMessage === "string" ? envelope.errorMessage : "";
    throw new Error(`${params.tool} failed: ${code} ${msg}`.trim());
  }

  // Try to parse the tool's JSON payload if present.
  const toolText = extractToolText(envelope);
  const parsedPayload: unknown = (() => {
    if (typeof toolText !== "string") return undefined;
    try {
      return JSON.parse(toolText);
    } catch {
      return toolText;
    }
  })();

  // Treat tool-level errors as failures.
  if (isRecord(parsedPayload) && typeof parsedPayload.status === "string") {
    const status = parsedPayload.status;
    if (status === "error" || status === "forbidden" || status === "timeout") {
      const err =
        typeof parsedPayload.error === "string" ? parsedPayload.error : "";
      throw new Error(
        `${params.tool} failed: ${status}${err ? `: ${err}` : ""}`,
      );
    }
  }

  return (parsedPayload ?? envelope) as T;
}

export async function sendToTaskSession(params: {
  handle: AgentHandle;
  taskId: string;
  message: string;
}): Promise<void> {
  const sessionKey = getTaskSessionKey(params.taskId);

  debugLog(`[OpenClaw] sessions_send @${params.handle} → ${sessionKey}`);

  await invokeOpenClawTool({
    handle: params.handle,
    tool: "sessions_send",
    args: {
      sessionKey,
      message: params.message,
      timeoutSeconds: 0,
    },
  });
}

export async function notifyAgentMention(params: {
  handle: AgentHandle;
  taskId: string;
  taskTitle: string;
  taskNumber?: number | null;
  projectName?: string | null;
  authorName: string;
  comment: string;
  taskUrl?: string;
}): Promise<void> {
  const taskRef =
    typeof params.taskNumber === "number"
      ? `#${params.taskNumber}`
      : params.taskId;

  const lines: string[] = [];
  lines.push(`🧵 Comment on task: "${params.taskTitle}"`);
  lines.push(`Task: ${taskRef}`);
  lines.push(`Task ID: ${params.taskId}`);
  if (params.projectName) lines.push(`Project: ${params.projectName}`);
  lines.push(`From: ${params.authorName}`);
  if (params.taskUrl) lines.push(`Link: ${params.taskUrl}`);
  lines.push("");
  lines.push(params.comment);
  lines.push("");
  lines.push("---");
  lines.push("Reply with a marker so the return-loop can post it back:");
  lines.push("TASK_COMMENT: <your reply>");
  lines.push(`TASK_COMPLETE:${params.taskId}`);

  await sendToTaskSession({
    handle: params.handle,
    taskId: params.taskId,
    message: lines.join("\n"),
  });
}

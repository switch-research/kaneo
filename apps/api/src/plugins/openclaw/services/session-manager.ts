import { createId } from "@paralleldrive/cuid2";
import { desc, eq } from "drizzle-orm";
import db from "../../../database";
import {
  openclawIngestLedgerTable,
  openclawTaskThreadTable,
} from "../../../database/schema";
import type { AgentHandle } from "../types";

export async function upsertTaskThread(params: {
  taskId: string;
  handle: AgentHandle;
  sessionKey: string;
}): Promise<void> {
  await db
    .insert(openclawTaskThreadTable)
    .values({
      id: createId(),
      taskId: params.taskId,
      handle: params.handle,
      sessionKey: params.sessionKey,
      watermarkTs: 0,
    })
    .onConflictDoUpdate({
      target: [openclawTaskThreadTable.taskId, openclawTaskThreadTable.handle],
      set: {
        sessionKey: params.sessionKey,
        updatedAt: new Date(),
      },
    });
}

export async function listThreadsToPoll(limit = 200) {
  return await db
    .select()
    .from(openclawTaskThreadTable)
    .orderBy(desc(openclawTaskThreadTable.updatedAt))
    .limit(limit);
}

export async function updateThreadWatermark(params: {
  id: string;
  watermarkTs: number;
}): Promise<void> {
  await db
    .update(openclawTaskThreadTable)
    .set({ watermarkTs: params.watermarkTs, updatedAt: new Date() })
    .where(eq(openclawTaskThreadTable.id, params.id));
}

export async function recordIngestOnce(params: {
  taskId: string;
  handle: AgentHandle;
  sessionKey: string;
  messageTs: number;
  markerType: string;
  markerIndex: number;
  markerHash?: string;
}): Promise<boolean> {
  const inserted = await db
    .insert(openclawIngestLedgerTable)
    .values({
      id: createId(),
      taskId: params.taskId,
      handle: params.handle,
      sessionKey: params.sessionKey,
      messageTs: params.messageTs,
      markerType: params.markerType,
      markerIndex: params.markerIndex,
      markerHash: params.markerHash,
    })
    .onConflictDoNothing()
    .returning({ id: openclawIngestLedgerTable.id });

  return inserted.length > 0;
}

import { subscribeToEvent } from "../../events";
import type { IntegrationPlugin } from "../types";
import { handleTaskCommentCreated } from "./events/task-comment-created";
import { startReturnLoopPoller } from "./services/dispatch-service";

export const openclawPlugin: IntegrationPlugin = {
  type: "openclaw",
  name: "OpenClaw",
  validateConfig: async () => ({ valid: true }),
};

export function initializeOpenClawPlugin(): void {
  // Poller: marker-based return loop (agent replies → comments / completion)
  startReturnLoopPoller();

  // Mention routing (comment_created → sessions_send)
  subscribeToEvent<{
    taskId: string;
    userId: string;
    projectId: string;
    rawComment?: string;
    authorName?: string | null;
  }>("task.comment_created", async (data) => {
    await handleTaskCommentCreated({
      taskId: data.taskId,
      projectId: data.projectId,
      rawComment: data.rawComment,
      authorName: data.authorName,
    });
  });
}

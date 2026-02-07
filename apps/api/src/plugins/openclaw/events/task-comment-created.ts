import { routeMentionsFromComment } from "../services/dispatch-service";

export async function handleTaskCommentCreated(event: {
  taskId: string;
  projectId: string;
  rawComment?: string;
  authorName?: string | null;
}): Promise<void> {
  const rawComment =
    typeof event.rawComment === "string" ? event.rawComment : "";
  if (!rawComment) return;

  const authorName = event.authorName?.trim() || "Unknown";

  await routeMentionsFromComment({
    taskId: event.taskId,
    projectId: event.projectId,
    rawComment,
    authorName,
  });
}

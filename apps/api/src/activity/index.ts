import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import db from "../database";
import { projectTable, taskTable, userTable } from "../database/schema";
import { publishEvent, subscribeToEvent } from "../events";
import { activitySchema } from "../schemas";
import { getAgentHandles, notifyAgentMention } from "../utils/openclaw";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import createActivity from "./controllers/create-activity";
import createComment from "./controllers/create-comment";
import deleteComment from "./controllers/delete-comment";
import getActivities from "./controllers/get-activities";
import updateComment from "./controllers/update-comment";

function extractMentionHandles(markdown: string): string[] {
  const handles = new Set<string>();

  // BlockNote mentions are stored as markdown links: [@smoke](mention:smoke)
  // Capture both the href and any raw @handle typing.
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

const activity = new Hono<{
  Variables: {
    userId: string;
  };
}>()
  .get(
    "/:taskId",
    describeRoute({
      operationId: "getActivities",
      tags: ["Activity"],
      description: "Get all activities for a specific task",
      responses: {
        200: {
          description: "List of activities for the task",
          content: {
            "application/json": { schema: resolver(v.array(activitySchema)) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string() })),
    workspaceAccess.fromTaskId(),
    async (c) => {
      const { taskId } = c.req.valid("param");
      const activities = await getActivities(taskId);
      return c.json(activities);
    },
  )
  .post(
    "/create",
    describeRoute({
      operationId: "createActivity",
      tags: ["Activity"],
      description: "Create a new activity (system-generated event)",
      responses: {
        200: {
          description: "Activity created successfully",
          content: {
            "application/json": { schema: resolver(activitySchema) },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        taskId: v.string(),
        userId: v.string(),
        message: v.string(),
        type: v.string(),
      }),
    ),
    workspaceAccess.fromTaskId(),
    async (c) => {
      const { taskId, userId, message, type } = c.req.valid("json");
      const activity = await createActivity(taskId, type, userId, message);
      return c.json(activity);
    },
  )
  .post(
    "/comment",
    describeRoute({
      operationId: "createComment",
      tags: ["Activity"],
      description: "Create a new comment on a task",
      responses: {
        200: {
          description: "Comment created successfully",
          content: {
            "application/json": { schema: resolver(activitySchema) },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        taskId: v.string(),
        comment: v.string(),
      }),
    ),
    workspaceAccess.fromTaskId(),
    async (c) => {
      const { taskId, comment } = c.req.valid("json");
      const userId = c.get("userId");
      const newComment = await createComment(taskId, userId, comment);

      const [user] = await db
        .select({ name: userTable.name })
        .from(userTable)
        .where(eq(userTable.id, userId));

      const [task] = await db
        .select({
          projectId: taskTable.projectId,
          title: taskTable.title,
          number: taskTable.number,
          projectName: projectTable.name,
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(eq(taskTable.id, taskId));

      if (task) {
        await publishEvent("task.comment_created", {
          taskId,
          userId,
          comment: `"${user?.name}" commented: ${comment}`,
          // For richer consumers (eg OpenClaw), keep the raw markdown too.
          rawComment: comment,
          authorName: user?.name ?? null,
          projectId: task.projectId,
        });

        const handles = getAgentHandles(extractMentionHandles(comment));
        if (handles.length > 0) {
          const authorName = user?.name ?? userId;

          void Promise.allSettled(
            handles.map((handle) =>
              notifyAgentMention({
                handle,
                taskId,
                taskTitle: task.title,
                taskNumber: task.number,
                projectName: task.projectName,
                authorName,
                comment,
              }),
            ),
          ).then((results) => {
            for (const r of results) {
              if (r.status === "rejected") {
                console.error("[openclaw] mention delivery failed:", r.reason);
              }
            }
          });
        }
      }

      return c.json(newComment);
    },
  )
  .put(
    "/comment",
    describeRoute({
      operationId: "updateComment",
      tags: ["Activity"],
      description: "Update an existing comment",
      responses: {
        200: {
          description: "Comment updated successfully",
          content: {
            "application/json": { schema: resolver(activitySchema) },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        activityId: v.string(),
        comment: v.string(),
      }),
    ),
    workspaceAccess.fromActivity("activityId"),
    async (c) => {
      const { activityId, comment } = c.req.valid("json");
      const userId = c.get("userId");
      const updatedComment = await updateComment(userId, activityId, comment);
      return c.json(updatedComment);
    },
  )
  .delete(
    "/comment",
    describeRoute({
      operationId: "deleteComment",
      tags: ["Activity"],
      description: "Delete a comment",
      responses: {
        200: {
          description: "Comment deleted successfully",
          content: {
            "application/json": { schema: resolver(activitySchema) },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        activityId: v.string(),
      }),
    ),
    workspaceAccess.fromActivity("activityId"),
    async (c) => {
      const { activityId } = c.req.valid("json");
      const userId = c.get("userId");
      const deletedComment = await deleteComment(userId, activityId);
      return c.json(deletedComment);
    },
  );

subscribeToEvent<{
  taskId: string;
  userId: string;
  type: string;
  content: string;
}>("task.created", async (data) => {
  if (!data.userId || !data.taskId || !data.type || !data.content) {
    return;
  }
  await createActivity(data.taskId, data.type, data.userId, data.content);
});

subscribeToEvent<{
  taskId: string;
  userId: string;
  oldStatus: string;
  newStatus: string;
  title: string;
  assigneeId?: string;
  type: string;
}>("task.status_changed", async (data) => {
  await createActivity(
    data.taskId,
    data.type,
    data.userId,
    `changed status from "${data.oldStatus}" to "${data.newStatus}"`,
  );
});

subscribeToEvent<{
  taskId: string;
  userId: string;
  oldPriority: string;
  newPriority: string;
  title: string;
  type: string;
}>("task.priority_changed", async (data) => {
  await createActivity(
    data.taskId,
    data.type,
    data.userId,
    `changed priority from "${data.oldPriority}" to "${data.newPriority}"`,
  );
});

subscribeToEvent<{
  taskId: string;
  userId: string;
  title: string;
  type: string;
}>("task.unassigned", async (data) => {
  await createActivity(
    data.taskId,
    data.type,
    data.userId,
    "unassigned the task",
  );
});

subscribeToEvent<{
  taskId: string;
  userId: string;
  oldAssignee: string | null;
  newAssignee: string;
  newAssigneeId: string;
  title: string;
  type: string;
}>("task.assignee_changed", async (data) => {
  await createActivity(
    data.taskId,
    data.type,
    data.userId,
    `assigned the task to ${data.newAssignee}`,
  );
});

subscribeToEvent<{
  taskId: string;
  userId: string;
  oldDueDate: Date | null;
  newDueDate: Date;
  title: string;
  type: string;
}>("task.due_date_changed", async (data) => {
  const oldDate = data.oldDueDate
    ? new Date(data.oldDueDate).toLocaleDateString()
    : "none";

  if (!data.newDueDate) {
    await createActivity(
      data.taskId,
      data.type,
      data.userId,
      "cleared the due date",
    );
    return;
  }

  const newDate = new Date(data.newDueDate).toLocaleDateString();
  await createActivity(
    data.taskId,
    data.type,
    data.userId,
    `changed due date from ${oldDate} to ${newDate}`,
  );
});

subscribeToEvent<{
  taskId: string;
  userId: string;
  oldTitle: string;
  newTitle: string;
  title: string;
  type: string;
}>("task.title_changed", async (data) => {
  await createActivity(
    data.taskId,
    data.type,
    data.userId,
    `changed title from "${data.oldTitle}" to "${data.newTitle}"`,
  );
});

export default activity;

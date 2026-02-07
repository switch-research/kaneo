CREATE TABLE "openclaw_ingest_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"handle" text NOT NULL,
	"session_key" text NOT NULL,
	"message_ts" bigint NOT NULL,
	"marker_type" text NOT NULL,
	"marker_index" integer DEFAULT 0 NOT NULL,
	"marker_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openclaw_task_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"handle" text NOT NULL,
	"session_key" text NOT NULL,
	"watermark_ts" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "openclaw_ingest_ledger" ADD CONSTRAINT "openclaw_ingest_ledger_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "openclaw_task_thread" ADD CONSTRAINT "openclaw_task_thread_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "openclaw_ingest_taskId_idx" ON "openclaw_ingest_ledger" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "openclaw_ingest_handle_idx" ON "openclaw_ingest_ledger" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "openclaw_ingest_unique_unq" ON "openclaw_ingest_ledger" USING btree ("task_id","handle","message_ts","marker_type","marker_index");--> statement-breakpoint
CREATE INDEX "openclaw_task_thread_taskId_idx" ON "openclaw_task_thread" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "openclaw_task_thread_handle_idx" ON "openclaw_task_thread" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "openclaw_task_thread_task_handle_unq" ON "openclaw_task_thread" USING btree ("task_id","handle");
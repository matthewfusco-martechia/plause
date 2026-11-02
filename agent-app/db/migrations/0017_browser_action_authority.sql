CREATE TABLE "browser_action_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"worker_session_id" text NOT NULL,
	"call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"browser_session_id" text,
	"observation_id" text,
	"input_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "browser_action_attempt_status" CHECK ("browser_action_attempts"."status" IN ('started','completed','unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "browser_action_root_unresolved" ON "browser_action_attempts" USING btree ("workspace_id","root_session_id") WHERE "browser_action_attempts"."status" IN ('started','unknown');
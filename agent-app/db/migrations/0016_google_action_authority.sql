CREATE TABLE "google_action_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input_hash" text NOT NULL,
	"encrypted_input" text,
	"principal_hash" text NOT NULL,
	"grant_version" integer NOT NULL,
	"state" text NOT NULL,
	"interaction_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_action_approval_state" CHECK ("google_action_approvals"."state" IN ('pending','approved','denied','revoked')),
	CONSTRAINT "google_action_approval_tool" CHECK ("google_action_approvals"."tool_name" IN ('gmail-send','gmail-update','calendar-create-event'))
);
--> statement-breakpoint
CREATE TABLE "google_action_dispatches" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"grant_version" integer NOT NULL,
	"state" text NOT NULL,
	"encrypted_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "google_action_dispatch_state" CHECK ("google_action_dispatches"."state" IN ('started','completed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "google_action_dispatches" ADD CONSTRAINT "google_action_dispatches_approval_id_google_action_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."google_action_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_action_unresolved_conversation" ON "google_action_dispatches" USING btree ("workspace_id","root_session_id") WHERE "google_action_dispatches"."state" IN ('started','unknown');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION plause_purge_deleted_user_provider_data() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE linq_webhook_inbox SET
    body_ciphertext = NULL,
    status = CASE WHEN status IN ('dispatching','unknown') THEN 'unknown' ELSE 'cancelled' END,
    user_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    error_code = 'user_deleted', updated_at = now()
  WHERE user_id = OLD.id;
  DELETE FROM google_workspace_oauth_states WHERE user_id = 'better-auth:' || OLD.id;
  DELETE FROM google_workspace_connections WHERE user_id = 'better-auth:' || OLD.id;
  UPDATE model_provider_attempts SET encrypted_result = NULL
  WHERE workspace_id = 'personal:' || substr(encode(sha256(convert_to('better-auth:' || OLD.id, 'UTF8')), 'hex'), 1, 32);
  UPDATE google_action_approvals SET encrypted_input = NULL,
    state = CASE WHEN state IN ('pending','approved') THEN 'revoked' ELSE state END
  WHERE user_id = 'better-auth:' || OLD.id;
  UPDATE google_action_dispatches SET encrypted_result = NULL,
    state = CASE WHEN state = 'started' THEN 'unknown' ELSE state END
  WHERE user_id = 'better-auth:' || OLD.id;
  RETURN OLD;
END;
$$;

CREATE TABLE "inkbox_webhook_inbox" (
	"event_key" text PRIMARY KEY NOT NULL,
	"message_key" text NOT NULL,
	"conversation_key" text NOT NULL,
	"identity_digest" text NOT NULL,
	"body_digest" text NOT NULL,
	"body_ciphertext" text,
	"user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	CONSTRAINT "inkbox_webhook_inbox_status_check" CHECK ("inkbox_webhook_inbox"."status" IN ('pending','claimed','dispatching','accepted','ignored','unknown','cancelled')),
	CONSTRAINT "inkbox_webhook_inbox_digests_check" CHECK ("inkbox_webhook_inbox"."event_key" ~ '^[a-f0-9]{64}$' AND "inkbox_webhook_inbox"."message_key" ~ '^[a-f0-9]{64}$' AND "inkbox_webhook_inbox"."conversation_key" ~ '^[a-f0-9]{64}$' AND "inkbox_webhook_inbox"."identity_digest" ~ '^[a-f0-9]{64}$' AND "inkbox_webhook_inbox"."body_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "inkbox_message_outbox" (
	"key" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"user_id" text,
	"workspace_id" text NOT NULL,
	"identity_digest" text NOT NULL,
	"owner_digest" text NOT NULL,
	"destination_digest" text NOT NULL,
	"body_digest" text NOT NULL,
	"intent_digest" text NOT NULL,
	"body_ciphertext" text,
	"provider_message_id" text,
	"status" text NOT NULL,
	"attempt_token" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"error_code" text,
	CONSTRAINT "inkbox_message_outbox_status_check" CHECK ("inkbox_message_outbox"."status" IN ('started','accepted','delivered','failed','unknown','cancelled')),
	CONSTRAINT "inkbox_message_outbox_digests_check" CHECK ("inkbox_message_outbox"."key" ~ '^[a-f0-9]{64}$' AND "inkbox_message_outbox"."identity_digest" ~ '^[a-f0-9]{64}$' AND "inkbox_message_outbox"."owner_digest" ~ '^[a-f0-9]{64}$' AND "inkbox_message_outbox"."destination_digest" ~ '^[a-f0-9]{64}$' AND "inkbox_message_outbox"."body_digest" ~ '^[a-f0-9]{64}$' AND "inkbox_message_outbox"."intent_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "internal_request_receipts" DROP CONSTRAINT "internal_request_receipts_path_check";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP CONSTRAINT "scheduled_agent_jobs_conversation_channel_check";--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" DROP CONSTRAINT "scheduled_agent_runs_report_status_check";--> statement-breakpoint
ALTER TABLE "inkbox_webhook_inbox" ADD CONSTRAINT "inkbox_webhook_inbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inkbox_message_outbox" ADD CONSTRAINT "inkbox_message_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inkbox_webhook_inbox_message_uidx" ON "inkbox_webhook_inbox" USING btree ("message_key");--> statement-breakpoint
CREATE INDEX "inkbox_webhook_inbox_pending_idx" ON "inkbox_webhook_inbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "inkbox_webhook_inbox_conversation_idx" ON "inkbox_webhook_inbox" USING btree ("conversation_key","status");--> statement-breakpoint
CREATE INDEX "inkbox_webhook_inbox_user_idx" ON "inkbox_webhook_inbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inkbox_webhook_inbox_retained_idx" ON "inkbox_webhook_inbox" USING btree ("expires_at") WHERE "inkbox_webhook_inbox"."body_ciphertext" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inkbox_message_outbox_unresolved_destination" ON "inkbox_message_outbox" USING btree ("destination_digest") WHERE "inkbox_message_outbox"."status" IN ('started','unknown');--> statement-breakpoint
CREATE INDEX "inkbox_message_outbox_owner_idx" ON "inkbox_message_outbox" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "inkbox_message_outbox_retained_idx" ON "inkbox_message_outbox" USING btree ("expires_at") WHERE "inkbox_message_outbox"."body_ciphertext" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_request_receipts" ADD CONSTRAINT "internal_request_receipts_path_check" CHECK ("internal_request_receipts"."path" IN ('/internal/scheduled-run/report', '/internal/scheduled-run/respond', '/internal/linq/dispatch', '/internal/inkbox/dispatch'));--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_conversation_channel_check" CHECK ("scheduled_agent_jobs"."conversation_channel" IN ('eve', 'linq', 'inkbox'));--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD CONSTRAINT "scheduled_agent_runs_report_status_check" CHECK ("scheduled_agent_runs"."report_status" IN ('not_ready', 'not_needed', 'pending', 'queued', 'delivered', 'suppressed', 'unknown'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION plause_purge_deleted_user_provider_data() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inkbox_webhook_inbox SET
    body_ciphertext = NULL,
    status = CASE WHEN status IN ('dispatching','unknown') THEN 'unknown' ELSE 'cancelled' END,
    user_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    error_code = 'user_deleted', updated_at = clock_timestamp()
  WHERE user_id = OLD.id;
  UPDATE inkbox_message_outbox SET
    body_ciphertext = NULL, provider_message_id = NULL,
    status = CASE WHEN status IN ('started','unknown') THEN 'unknown' ELSE status END,
    user_id = NULL, error_code = 'user_deleted', updated_at = clock_timestamp()
  WHERE user_id = OLD.id;
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

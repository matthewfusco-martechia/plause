CREATE TABLE "internal_request_receipts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"signature_digest" text NOT NULL,
	"path" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "internal_request_receipts_signature_check" CHECK ("internal_request_receipts"."signature_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "internal_request_receipts_path_check" CHECK ("internal_request_receipts"."path" IN ('/internal/scheduled-run/report', '/internal/scheduled-run/respond', '/internal/linq/dispatch'))
);
--> statement-breakpoint
CREATE TABLE "linq_webhook_inbox" (
	"event_key" text PRIMARY KEY NOT NULL,
	"message_key" text NOT NULL,
	"conversation_key" text NOT NULL,
	"line_digest" text NOT NULL,
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
	CONSTRAINT "linq_webhook_inbox_status_check" CHECK ("linq_webhook_inbox"."status" IN ('pending','claimed','dispatching','accepted','ignored','unknown','cancelled')),
	CONSTRAINT "linq_webhook_inbox_digests_check" CHECK ("linq_webhook_inbox"."event_key" ~ '^[a-f0-9]{64}$' AND "linq_webhook_inbox"."message_key" ~ '^[a-f0-9]{64}$' AND "linq_webhook_inbox"."conversation_key" ~ '^[a-f0-9]{64}$' AND "linq_webhook_inbox"."line_digest" ~ '^[a-f0-9]{64}$' AND "linq_webhook_inbox"."body_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "model_budget_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"held_micro_usd" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "model_budget_nonnegative" CHECK ("model_budget_accounts"."spent_micro_usd" >= 0 AND "model_budget_accounts"."held_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_provider_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"model" text NOT NULL,
	"global_account_id" text NOT NULL,
	"user_account_id" text NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"actual_micro_usd" bigint,
	"input_tokens" integer,
	"output_tokens" integer,
	"status" text NOT NULL,
	"encrypted_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "model_provider_attempt_status" CHECK ("model_provider_attempts"."status" IN ('reserved','started','completed','unknown')),
	CONSTRAINT "model_provider_attempt_cost" CHECK ("model_provider_attempts"."reserved_micro_usd" > 0 AND ("model_provider_attempts"."actual_micro_usd" IS NULL OR "model_provider_attempts"."actual_micro_usd" >= 0))
);
--> statement-breakpoint
CREATE TABLE "google_workspace_connections" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"revocation_pending" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"account_subject" text,
	"account_label" text,
	"granted_scopes" text,
	"encrypted_tokens" text,
	"access_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_workspace_connection_status" CHECK ("google_workspace_connections"."status" IN ('pending','connected','disconnected'))
);
--> statement-breakpoint
CREATE TABLE "google_workspace_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"browser_hash" text NOT NULL,
	"connection_version" integer NOT NULL,
	"encrypted_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "settings_key_check";--> statement-breakpoint
ALTER TABLE "linq_webhook_inbox" ADD CONSTRAINT "linq_webhook_inbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "internal_request_receipts_expiry_idx" ON "internal_request_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linq_webhook_inbox_message_uidx" ON "linq_webhook_inbox" USING btree ("message_key");--> statement-breakpoint
CREATE INDEX "linq_webhook_inbox_pending_idx" ON "linq_webhook_inbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "linq_webhook_inbox_conversation_idx" ON "linq_webhook_inbox" USING btree ("conversation_key","status");--> statement-breakpoint
CREATE INDEX "linq_webhook_inbox_user_idx" ON "linq_webhook_inbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "linq_webhook_inbox_retained_idx" ON "linq_webhook_inbox" USING btree ("expires_at") WHERE "linq_webhook_inbox"."body_ciphertext" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_key_check" CHECK ("settings"."key" IN ('gateway_model','openai_model'));--> statement-breakpoint
-- Erasure keeps provider replay/charge tombstones while removing private payloads.
CREATE FUNCTION plause_purge_deleted_user_provider_data() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER plause_user_provider_erasure BEFORE DELETE ON "user"
FOR EACH ROW EXECUTE FUNCTION plause_purge_deleted_user_provider_data();

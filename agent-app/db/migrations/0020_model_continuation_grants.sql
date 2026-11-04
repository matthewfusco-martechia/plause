CREATE TABLE "model_continuation_grants" (
	"authorization_hash" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_continuation_grant_authority" CHECK ("model_continuation_grants"."authorization_hash" ~ '^[a-f0-9]{64}$' AND "model_continuation_grants"."expires_at" > "model_continuation_grants"."authorized_at" AND "model_continuation_grants"."expires_at" <= "model_continuation_grants"."authorized_at" + interval '1 hour')
);
--> statement-breakpoint
ALTER TABLE "model_continuation_grants" ADD CONSTRAINT "model_continuation_grants_attempt_id_model_provider_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."model_provider_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_continuation_grants_attempt_idx" ON "model_continuation_grants" USING btree ("attempt_id");
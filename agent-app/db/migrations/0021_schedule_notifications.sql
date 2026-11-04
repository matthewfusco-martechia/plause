ALTER TABLE "internal_request_receipts" DROP CONSTRAINT "internal_request_receipts_path_check";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD COLUMN "notification_policy" jsonb;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD COLUMN "job_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD COLUMN "report_not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "internal_request_receipts" ADD CONSTRAINT "internal_request_receipts_path_check" CHECK ("internal_request_receipts"."path" IN ('/internal/scheduled-run/report', '/internal/scheduled-run/respond', '/internal/linq/dispatch', '/internal/inkbox/dispatch', '/internal/schedules/tick'));
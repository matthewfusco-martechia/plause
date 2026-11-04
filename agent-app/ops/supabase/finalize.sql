-- Run after the pinned app and workflow migrations, as their postgres owner.
-- This is also the explicit grant refresh after a future reviewed migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF current_user <> 'postgres' OR current_database() <> 'postgres'
    OR to_regclass('public."user"') IS NULL
    OR to_regclass('public.inkbox_message_outbox') IS NULL
    OR to_regclass('workflow.workflow_runs') IS NULL
    OR to_regclass('graphile_worker.migrations') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plause_runtime') THEN
    RAISE EXCEPTION 'Expected role, database or installed schemas are absent';
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA public, workflow, workflow_drizzle, graphile_worker, drizzle
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public, workflow, workflow_drizzle, graphile_worker, drizzle
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, workflow, workflow_drizzle, graphile_worker, drizzle
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, workflow, workflow_drizzle, graphile_worker, drizzle
  FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA public, workflow, graphile_worker TO plause_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, workflow, graphile_worker
  TO plause_runtime;
-- Recovery permissions are audit records. Runtime may append, never rewrite.
REVOKE UPDATE, DELETE ON public.model_continuation_grants FROM plause_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public, workflow, graphile_worker
  TO plause_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, workflow, graphile_worker
  TO plause_runtime;

-- Graphile 0.16.6 enables RLS on its four private queue tables. The separate
-- runtime is not their owner and has no BYPASSRLS: permit only this backend
-- role to operate its dedicated queue. Keep RLS enabled and API roles denied.
DROP POLICY IF EXISTS plause_runtime_worker ON graphile_worker._private_tasks;
CREATE POLICY plause_runtime_worker ON graphile_worker._private_tasks
  TO plause_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS plause_runtime_worker ON graphile_worker._private_jobs;
CREATE POLICY plause_runtime_worker ON graphile_worker._private_jobs
  TO plause_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS plause_runtime_worker ON graphile_worker._private_job_queues;
CREATE POLICY plause_runtime_worker ON graphile_worker._private_job_queues
  TO plause_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS plause_runtime_worker ON graphile_worker._private_known_crontabs;
CREATE POLICY plause_runtime_worker ON graphile_worker._private_known_crontabs
  TO plause_runtime USING (true) WITH CHECK (true);
COMMIT;

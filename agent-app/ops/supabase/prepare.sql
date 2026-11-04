-- Dedicated, empty Plause Supabase project only. Run as postgres after the
-- operator verifies the project target and TLS on both connection legs.
-- Apply before application/workflow migrations, never to a shared database.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF current_user <> 'postgres' OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Unexpected setup role or database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','workflow','workflow_drizzle','graphile_worker','drizzle')
      AND c.relkind IN ('r','p','v','m','S','f')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','workflow','workflow_drizzle','graphile_worker','drizzle')
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname IN ('workflow','workflow_drizzle','graphile_worker','drizzle')
  ) OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plause_runtime') THEN
    RAISE EXCEPTION 'Setup requires an empty dedicated target and no existing runtime role';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN
    RAISE EXCEPTION 'Expected Supabase API roles are absent';
  END IF;
END;
$$;

-- The pinned workflow migration creates its schema itself. PostgreSQL gives
-- new schemas no PUBLIC usage; leave those namespaces to their migrations.
REVOKE ALL ON SCHEMA public
  FROM PUBLIC, anon, authenticated, service_role;

-- A schema-local function revoke cannot override PostgreSQL's global PUBLIC
-- EXECUTE default. Close the global default for this installation's owner too.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON FUNCTIONS
  FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON TABLES
  FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON SEQUENCES
  FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

-- No password or login is granted by this SQL file. Configure LOGIN separately
-- with a newly generated private credential after all acceptance checks pass.
CREATE ROLE plause_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
COMMIT;

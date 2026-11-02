-- Fictional local-only identities. setup.mjs applies this only with --local.
INSERT OR IGNORE INTO users (id, display_name, status, created_at)
VALUES ('u_alex', 'Alex', 'active', 1793318400000), ('u_sam', 'Sam', 'active', 1793318400000);
INSERT OR IGNORE INTO bindings (provider, business_id, subject_id, user_id, channel)
VALUES ('mock', 'plause-local', 'mock-alex', 'u_alex', 'mock'), ('mock', 'plause-local', 'mock-sam', 'u_sam', 'mock');

-- Dedicated fictional smoke-test account; quiet hours disabled only here.
INSERT OR IGNORE INTO users(id,display_name,status,created_at,quiet_start,quiet_end)
VALUES ('u_acceptance','Acceptance test','active',0,'00:00','00:00');

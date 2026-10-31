CREATE TABLE core_controls (id INTEGER PRIMARY KEY CHECK(id=1), restart_bot INTEGER NOT NULL DEFAULT 0);
INSERT INTO core_controls(id) VALUES(1);
CREATE TABLE core_jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, operation_id TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', due_at INTEGER NOT NULL, lease_until INTEGER,
 owner TEXT, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX core_jobs_due ON core_jobs(state,due_at);
CREATE TABLE domain_events (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE server_monitor_samples (
 server_id TEXT PRIMARY KEY, game TEXT NOT NULL, signature TEXT NOT NULL,
 document TEXT NOT NULL, updated_at INTEGER NOT NULL, last_success_at INTEGER
);
CREATE INDEX server_monitor_sample_age ON server_monitor_samples(updated_at);

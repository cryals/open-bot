ALTER TABLE settings ADD COLUMN log_channel_id TEXT;
CREATE TABLE activity_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
 actor TEXT NOT NULL, actor_name TEXT NOT NULL, kind TEXT NOT NULL,
 target TEXT NOT NULL, summary TEXT NOT NULL, details TEXT NOT NULL CHECK(json_valid(details)),
 before_text TEXT, after_text TEXT, diff TEXT,
 log_channel_id TEXT, delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX activity_time ON activity_log(created_at);
CREATE INDEX activity_delivery ON activity_log(delivered,log_channel_id,id);

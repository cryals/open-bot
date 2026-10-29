CREATE TABLE media (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE composer (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL CHECK(json_valid(document)), version INTEGER NOT NULL);
CREATE TABLE templates (id TEXT PRIMARY KEY, title TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), created_at INTEGER NOT NULL);
CREATE TABLE sent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)), actor TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(channel_id, message_id)
);
CREATE TABLE dispatches (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, channel_id TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)), next_index INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document TEXT NOT NULL CHECK(json_valid(document)),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  message_channel_id TEXT,
  admin_role_id TEXT,
  published_revision INTEGER REFERENCES revisions(id)
);
CREATE TABLE draft (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  document TEXT NOT NULL CHECK(json_valid(document)),
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

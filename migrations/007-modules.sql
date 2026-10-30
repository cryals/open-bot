CREATE TABLE module_config (
 id TEXT PRIMARY KEY, document TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE server_watches (
 id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 message_id TEXT, nonce TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
 UNIQUE(server_id,channel_id)
);
CREATE TABLE power_operations (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, server_id TEXT NOT NULL, action TEXT NOT NULL,
 version TEXT, immediate INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, config_version INTEGER NOT NULL, result TEXT
);
CREATE UNIQUE INDEX power_one_running ON power_operations(server_id) WHERE state='running';
CREATE TABLE tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL, category_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'creating', stage TEXT NOT NULL DEFAULT 'channel',
 channel_id TEXT UNIQUE, thread_id TEXT UNIQUE, staff_channel_id TEXT, staff_message_id TEXT, control_message_id TEXT,
 assignee TEXT, participants TEXT NOT NULL DEFAULT '[]', form TEXT NOT NULL DEFAULT '{}',
 reason TEXT, closed_by TEXT, created_at INTEGER NOT NULL, closed_at INTEGER, expires_at INTEGER,
 next_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
 archive_gap TEXT
);
CREATE UNIQUE INDEX ticket_one_active ON tickets(author_id,category_id)
 WHERE state IN ('creating','open','claimed','waiting','closing');
CREATE TABLE ticket_messages (
 id TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
 scope TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
 content TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
 bot INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ticket_messages_order ON ticket_messages(ticket_id,scope,created_at,id);
CREATE TABLE ticket_revisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES ticket_messages(id) ON DELETE CASCADE,
 content TEXT NOT NULL, changed_at INTEGER NOT NULL, kind TEXT NOT NULL, snapshot TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE ticket_files (
 id TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES ticket_messages(id) ON DELETE CASCADE,
 attachment_id TEXT NOT NULL, scope TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
 mime TEXT NOT NULL, url TEXT NOT NULL, filename TEXT, state TEXT NOT NULL DEFAULT 'pending',
 error TEXT, next_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 UNIQUE(message_id,attachment_id)
);
CREATE TABLE ticket_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
 actor TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE ticket_panels (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, message_id TEXT, nonce TEXT NOT NULL,
 document TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT
);
CREATE TABLE metric_snapshots (
 process TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE ticket_totals (
 id INTEGER PRIMARY KEY CHECK(id=1), created INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0,
 first_responses INTEGER NOT NULL DEFAULT 0, first_response_seconds REAL NOT NULL DEFAULT 0,
 resolution_seconds REAL NOT NULL DEFAULT 0
);
INSERT INTO ticket_totals(id) VALUES(1);
ALTER TABLE tickets ADD COLUMN first_response_at INTEGER;
CREATE TABLE ticket_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
 actor TEXT NOT NULL, action TEXT NOT NULL, value TEXT NOT NULL, next_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, error TEXT, state TEXT NOT NULL DEFAULT 'pending',
 UNIQUE(ticket_id)
);
CREATE TABLE power_batches (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, operations TEXT NOT NULL, state TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);

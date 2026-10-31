CREATE TABLE moderation_cases (
 id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
 action TEXT NOT NULL, target TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
 duration INTEGER, source TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER, confirmed_at INTEGER, updated_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '{}',
 error TEXT, revision INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX moderation_target ON moderation_cases(target,id);
CREATE TABLE moderation_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES moderation_cases(id),
 actor TEXT NOT NULL, kind TEXT NOT NULL, document TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE moderation_delivery (
 event_id TEXT PRIMARY KEY REFERENCES domain_events(id), case_id INTEGER NOT NULL,
 channel_id TEXT, message_id TEXT, state TEXT NOT NULL DEFAULT 'pending',
 next_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE TABLE moderation_locks (
 channel_id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, before_allow TEXT NOT NULL,
 before_deny TEXT NOT NULL, applied_allow TEXT NOT NULL, applied_deny TEXT NOT NULL
);
CREATE TABLE moderation_active (
 target TEXT NOT NULL, kind TEXT NOT NULL, case_id INTEGER NOT NULL,
 expected TEXT, PRIMARY KEY(target,kind)
);

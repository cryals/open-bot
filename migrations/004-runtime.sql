CREATE TABLE runtime_locks (
 name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE publication_attempts (
 fingerprint TEXT PRIMARY KEY, nonce TEXT NOT NULL
);

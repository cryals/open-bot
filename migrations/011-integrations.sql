CREATE TABLE integration_credentials (provider TEXT NOT NULL,account TEXT NOT NULL,encrypted TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(provider,account));
CREATE UNIQUE INDEX feed_channel_dedup ON feed_delivery(channel_id,content_id);

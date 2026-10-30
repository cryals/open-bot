ALTER TABLE activity_log ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX activity_event_id ON activity_log(event_id);

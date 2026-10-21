-- 001_initial.sql
-- Initial schema for veronica v0.1.0

CREATE TABLE IF NOT EXISTS inbound_events (
  id TEXT PRIMARY KEY,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('whatsapp', 'email')),
  source_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_metadata TEXT NOT NULL,
  processing_status TEXT NOT NULL CHECK (processing_status IN ('accepted', 'ignored', 'rejected', 'failed')),
  UNIQUE (source_channel, source_event_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('whatsapp', 'email')),
  source_message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'video', 'audio', 'document', 'sticker', 'other_media')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_source ON messages (source_channel, source_message_id);

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  destination_channel TEXT NOT NULL CHECK (destination_channel IN ('whatsapp', 'email')),
  destination_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'submitted', 'delivered', 'failed', 'dead_letter', 'unknown')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  provider_message_id TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_claimable ON delivery_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_provider_msg_id ON delivery_jobs (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_message_id ON delivery_jobs (message_id);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_job_id TEXT NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('in_progress', 'submitted', 'delivered', 'transient_error', 'permanent_error', 'auth_error', 'ambiguous_error')),
  error_code TEXT,
  provider_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_job_id ON delivery_attempts (delivery_job_id, attempt_number);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('whatsapp', 'email')),
  source_identity TEXT NOT NULL,
  destination_channel TEXT NOT NULL CHECK (destination_channel IN ('whatsapp', 'email')),
  destination_identity TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  UNIQUE (source_channel, source_identity, destination_channel, destination_identity)
);

CREATE INDEX IF NOT EXISTS idx_routes_lookup ON routes (source_channel, source_identity, enabled);

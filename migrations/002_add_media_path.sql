-- 002_add_media_path.sql
-- Add optional media_path to messages table for downloaded audio/media attachments
ALTER TABLE messages ADD COLUMN media_path TEXT;

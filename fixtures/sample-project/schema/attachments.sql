CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  object_key TEXT NOT NULL
);

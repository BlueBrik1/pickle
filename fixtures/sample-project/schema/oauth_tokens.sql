CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  provider_name TEXT NOT NULL,
  token_reference TEXT NOT NULL
);

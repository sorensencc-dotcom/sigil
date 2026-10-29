-- Per-viewer contacts: each human keeps their own display name for a login
-- (an endpoint id, a human id, or an email address). Names here override the
-- registry display_name for that viewer only.
CREATE TABLE contacts (
  contact_id TEXT PRIMARY KEY,
  owner_human_id TEXT NOT NULL REFERENCES humans(human_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('endpoint', 'human', 'email')),
  login TEXT NOT NULL CHECK (char_length(login) BETWEEN 1 AND 254),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX contacts_owner_login_unique ON contacts (owner_human_id, lower(login));

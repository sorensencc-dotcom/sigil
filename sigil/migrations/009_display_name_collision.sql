ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS normalized_display_name TEXT GENERATED ALWAYS AS (lower(trim(display_name))) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS endpoints_owner_display_name_idx ON endpoints(owner_id, normalized_display_name);

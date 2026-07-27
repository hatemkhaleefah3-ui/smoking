CREATE TABLE IF NOT EXISTS lectures (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  design_id TEXT NOT NULL CHECK (design_id IN ('classic', 'enhanced', 'editorial')),
  schema_version TEXT NOT NULL CHECK (schema_version IN ('1.0', '2.1')),
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS lectures_created_at_idx ON lectures(created_at);
CREATE INDEX IF NOT EXISTS lectures_size_bytes_idx ON lectures(size_bytes);
CREATE INDEX IF NOT EXISTS lectures_title_idx ON lectures(title COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS publish_rate_limits (
  ip TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  publish_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

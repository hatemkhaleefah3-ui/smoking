CREATE TABLE IF NOT EXISTS pdf_extraction_jobs (
  id TEXT PRIMARY KEY,
  source_filename TEXT NOT NULL,
  requested_json TEXT,
  image_count INTEGER NOT NULL CHECK (image_count > 0),
  output_r2_key TEXT NOT NULL UNIQUE,
  output_filename TEXT NOT NULL,
  output_content_type TEXT NOT NULL,
  output_size_bytes INTEGER NOT NULL CHECK (output_size_bytes >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pdf_extraction_jobs_created_at_idx
  ON pdf_extraction_jobs(created_at);

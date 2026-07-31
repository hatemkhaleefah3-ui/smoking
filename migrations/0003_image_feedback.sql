CREATE TABLE IF NOT EXISTS image_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_url TEXT NOT NULL,
  source TEXT NOT NULL,
  query_term TEXT NOT NULL,
  topic TEXT,
  rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS image_feedback_query_topic_idx
  ON image_feedback(query_term COLLATE NOCASE, topic COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS image_feedback_image_url_idx
  ON image_feedback(image_url);

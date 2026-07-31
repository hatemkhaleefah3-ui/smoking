CREATE TABLE IF NOT EXISTS image_feedback_profiles (
  image_url TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  creator TEXT,
  collection_name TEXT,
  title TEXT,
  caption TEXT,
  keywords_json TEXT,
  topic_cluster TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS image_feedback_profiles_score_idx
  ON image_feedback_profiles(score DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS image_feedback_profiles_source_idx
  ON image_feedback_profiles(source, creator);

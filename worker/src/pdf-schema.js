let schemaPromise = null;

export async function ensurePdfExtractionSchema(env, HttpError) {
  if (!env.DB) throw new HttpError(500, 'D1 binding “DB” is not configured for this environment.');
  if (!schemaPromise) {
    schemaPromise = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS pdf_extraction_jobs (
        id TEXT PRIMARY KEY,
        source_filename TEXT NOT NULL,
        requested_json TEXT,
        image_count INTEGER NOT NULL CHECK (image_count > 0),
        output_r2_key TEXT NOT NULL UNIQUE,
        output_filename TEXT NOT NULL,
        output_content_type TEXT NOT NULL,
        output_size_bytes INTEGER NOT NULL CHECK (output_size_bytes >= 0),
        created_at TEXT NOT NULL
      )`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS pdf_extraction_jobs_created_at_idx ON pdf_extraction_jobs(created_at)')
    ]).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  try {
    await schemaPromise;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pdf_extraction_schema_initialization_failed',
      message: error instanceof Error ? error.message : String(error)
    }));
    throw new HttpError(500, 'The PDF extraction database could not be initialized. Check the DB binding and retry.');
  }
}

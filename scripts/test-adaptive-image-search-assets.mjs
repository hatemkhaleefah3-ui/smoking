import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const styles = await readFile(new URL('../dist/styles.css', import.meta.url), 'utf8');
const css = await readFile(new URL('../dist/adaptive-image-search.css', import.meta.url), 'utf8');
const frontend = await readFile(new URL('../dist/adaptive-image-search.js', import.meta.url), 'utf8');
const refinements = await readFile(new URL('../dist/studio-refinements.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../dist/_worker.js', import.meta.url), 'utf8');
const feedbackMigration = await readFile(new URL('../migrations/0003_image_feedback.sql', import.meta.url), 'utf8');
const profileMigration = await readFile(new URL('../migrations/0004_image_feedback_profiles.sql', import.meta.url), 'utf8');

assert.match(styles, /adaptive-image-search\.css/);
assert.match(refinements, /adaptive-image-search\.js/);
assert.match(frontend, /\/api\/image-search/);
assert.match(frontend, /\/api\/image-search\/feedback/);
assert.match(frontend, /Refine by a caption keyword/);
assert.match(frontend, /Refresh and re-rank/);
assert.match(frontend, /MAX_SEARCH_WAIT_MS\s*=\s*15_000/);
assert.match(frontend, /finally\s*\{/);
assert.match(frontend, /requiresKeyword/);
assert.match(frontend, /keywordOptions/);
assert.match(frontend, /result\.thumbnailUrl/);
assert.match(frontend, /fallbackAttempted/);
assert.doesNotMatch(frontend, /SESSION_DOWNVOTES_KEY/);
assert.doesNotMatch(frontend, /excludeUrls/);
assert.match(css, /\.adaptive-image-results/);
assert.match(css, /\.adaptive-image-topic-options/);
assert.match(css, /\.adaptive-image-votes/);

assert.match(worker, /adaptive-image-pools/);
assert.match(worker, /Promise\.allSettled/);
assert.match(worker, /NLM Open-i timed out, showing other sources/);
assert.match(worker, /base-query-fallback/);
assert.match(worker, /persistent-log-weight-with-metadata-similarity/);
assert.match(worker, /similarityFeedbackScore/);
assert.match(worker, /genericDropped/);
assert.match(worker, /same-sentence/);
assert.match(worker, /same-caption/);
assert.match(worker, /title-caption/);
assert.match(worker, /OPENVERSE_RESULT_LIMIT = 20/);
assert.match(worker, /page_size["']?, String\(OPENVERSE_RESULT_LIMIT\)/);
assert.doesNotMatch(worker, /negativeRemovalThreshold:\s*-3/);

assert.match(feedbackMigration, /CREATE TABLE IF NOT EXISTS image_feedback/);
assert.match(profileMigration, /CREATE TABLE IF NOT EXISTS image_feedback_profiles/);
assert.match(profileMigration, /keywords_json TEXT/);
assert.match(profileMigration, /topic_cluster TEXT/);
assert.match(profileMigration, /score INTEGER NOT NULL DEFAULT 0/);

await access(new URL('../dist/adaptive-image-search.css', import.meta.url));
await access(new URL('../dist/adaptive-image-search.js', import.meta.url));

console.log('Data-driven adaptive image search production asset validation passed.');

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const styles = await readFile(new URL('../dist/styles.css', import.meta.url), 'utf8');
const css = await readFile(new URL('../dist/adaptive-image-search.css', import.meta.url), 'utf8');
const frontend = await readFile(new URL('../dist/adaptive-image-search.js', import.meta.url), 'utf8');
const refinements = await readFile(new URL('../dist/studio-refinements.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../dist/_worker.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/0003_image_feedback.sql', import.meta.url), 'utf8');

assert.match(styles, /adaptive-image-search\.css/);
assert.match(refinements, /adaptive-image-search\.js/);
assert.match(frontend, /\/api\/image-search/);
assert.match(frontend, /\/api\/image-search\/feedback/);
assert.match(frontend, /Choose what you mean/);
assert.match(frontend, /Retry without downvoted images/);
assert.match(frontend, /sessionStorage/);
assert.match(css, /\.adaptive-image-results/);
assert.match(css, /\.adaptive-image-topic-options/);
assert.match(css, /\.adaptive-image-votes/);
assert.match(worker, /\/api\/image-search/);
assert.match(worker, /commons\.wikimedia\.org/);
assert.match(worker, /api\.openverse\.org/);
assert.match(worker, /openi\.nlm\.nih\.gov/);
assert.match(worker, /wbsearchentities/);
assert.match(worker, /wbgetentities/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS image_feedback/);
assert.match(migration, /rating INTEGER NOT NULL CHECK \(rating IN \(-1, 1\)\)/);

await access(new URL('../dist/adaptive-image-search.css', import.meta.url));
await access(new URL('../dist/adaptive-image-search.js', import.meta.url));

console.log('Adaptive image search production asset validation passed.');

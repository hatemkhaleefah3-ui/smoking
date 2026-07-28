import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bundle = await readFile(new URL('../dist/_worker.js', import.meta.url), 'utf8');

assert.match(bundle, /\/api\/search/);
assert.match(bundle, /GEMINI_API_KEY/);
assert.match(bundle, /\/api\/images/);
assert.match(bundle, /image_upload_rate_limits/);
assert.match(bundle, /max-age=31536000, immutable/);
assert.match(bundle, /ASSETS\.fetch/);
assert.doesNotMatch(bundle, /from\s+["']\.\//);
assert.doesNotMatch(bundle, /import\s+["']\.\//);

console.log('Advanced Mode Worker bundle validation passed.');

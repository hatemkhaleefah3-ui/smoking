import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const bundle = await readFile(new URL('../dist/_worker.js', import.meta.url), 'utf8');
const pdfRuntime = await readFile(new URL('../dist/pdf-extractor-runtime.js', import.meta.url), 'utf8');
const pdfWasm = await stat(new URL('../dist/vendor/mupdf-wasm.wasm', import.meta.url));

assert.match(bundle, /\/api\/search/);
assert.match(bundle, /GEMINI_API_KEY/);
assert.match(bundle, /\/api\/images/);
assert.match(bundle, /image_upload_rate_limits/);
assert.match(bundle, /max-age=31536000, immutable/);
assert.match(bundle, /\/api\/pdf-extractions/);
assert.match(bundle, /pdf_extraction_jobs/);
assert.match(bundle, /ASSETS\.fetch/);
assert.doesNotMatch(bundle, /from\s+["']\.\//);
assert.doesNotMatch(bundle, /import\s+["']\.\//);
assert.match(pdfRuntime, /preserve-images/);
assert.match(pdfRuntime, /This PDF has no extractable embedded images/);
assert.ok(pdfWasm.size > 1_000_000, 'MuPDF WASM asset should be present as a static file.');

console.log('Advanced Mode Worker and PDF runtime validation passed.');

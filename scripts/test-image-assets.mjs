import assert from 'node:assert/strict';
import { handleImageAssetRequest } from '../worker/src/image-assets.js';

const rows = new Map();
const db = {
  prepare(sql) {
    const statement = {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes('SELECT window_started')) return rows.get(this.values[0]) || null;
        return null;
      },
      async run() {
        if (sql.includes('INSERT INTO image_upload_rate_limits')) {
          rows.set(this.values[0], { window_started: this.values[1], upload_count: 1, upload_bytes: this.values[2] });
        }
        if (sql.includes('UPDATE image_upload_rate_limits')) {
          const row = rows.get(this.values[1]);
          rows.set(this.values[1], { ...row, upload_count: row.upload_count + 1, upload_bytes: row.upload_bytes + this.values[0] });
        }
        return { success: true };
      }
    };
    return statement;
  }
};

const objects = new Map();
const bucket = {
  async put(key, body, options) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(await new Response(body).arrayBuffer());
    objects.set(key, { bytes, options });
    return { size: bytes.byteLength };
  },
  async get(key) {
    const stored = objects.get(key);
    if (!stored) return null;
    return {
      body: new Response(stored.bytes).body,
      httpMetadata: stored.options.httpMetadata,
      httpEtag: '"test-etag"',
      writeHttpMetadata(headers) {
        headers.set('Content-Type', stored.options.httpMetadata.contentType);
        headers.set('Cache-Control', stored.options.httpMetadata.cacheControl);
      }
    };
  }
};

const form = new FormData();
form.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'diagram.png');
form.append('label', 'Glycolysis pathway');
const uploadRequest = new Request('https://lecture.example/api/images', {
  method: 'POST',
  headers: { Origin: 'https://lecture.example', 'CF-Connecting-IP': '203.0.113.7' },
  body: form
});
const uploadResponse = await handleImageAssetRequest(uploadRequest, { DB: db, LECTURES: bucket }, new URL(uploadRequest.url));
assert.equal(uploadResponse.status, 201);
const upload = await uploadResponse.json();
assert.match(upload.url, /^https:\/\/lecture\.example\/api\/images\/[0-9a-f-]{36}\.png$/);
assert.equal(upload.label, 'Glycolysis pathway');

const imageRequest = new Request(upload.url);
const imageResponse = await handleImageAssetRequest(imageRequest, { DB: db, LECTURES: bucket }, new URL(imageRequest.url));
assert.equal(imageResponse.status, 200);
assert.equal(imageResponse.headers.get('Content-Type'), 'image/png');
assert.match(imageResponse.headers.get('Cache-Control'), /immutable/);
assert.deepEqual(new Uint8Array(await imageResponse.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));

const invalidForm = new FormData();
invalidForm.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'unsafe.svg');
const invalidRequest = new Request('https://lecture.example/api/images', {
  method: 'POST',
  headers: { Origin: 'https://lecture.example' },
  body: invalidForm
});
const invalidResponse = await handleImageAssetRequest(invalidRequest, { DB: db, LECTURES: bucket }, new URL(invalidRequest.url));
assert.equal(invalidResponse.status, 415);

console.log('R2 image upload and delivery validation passed.');

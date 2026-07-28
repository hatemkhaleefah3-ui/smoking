import assert from 'node:assert/strict';
import { handlePdfExtractionRequest } from '../worker/src/pdf-routes.js';

const records = new Map();
const objects = new Map();
const env = {
  MAX_EXTRACTED_IMAGE_BYTES: '67108864',
  DB: {
    prepare(sql) {
      return {
        sql,
        bind(...values) {
          return {
            async run() {
              if (/INSERT INTO pdf_extraction_jobs/.test(sql)) {
                const [id, sourceFilename, requestedJson, imageCount, outputR2Key, outputFilename, outputContentType, outputSizeBytes, createdAt] = values;
                records.set(id, {
                  id,
                  source_filename: sourceFilename,
                  requested_json: requestedJson,
                  image_count: imageCount,
                  output_r2_key: outputR2Key,
                  output_filename: outputFilename,
                  output_content_type: outputContentType,
                  output_size_bytes: outputSizeBytes,
                  created_at: createdAt
                });
              }
              return { success: true };
            },
            async first() {
              if (/FROM pdf_extraction_jobs/.test(sql)) return records.get(values[0]) || null;
              return null;
            }
          };
        }
      };
    },
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    }
  },
  LECTURES: {
    async put(key, body, metadata) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, metadata });
      return { size: bytes.byteLength };
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { body: stored.bytes, size: stored.bytes.byteLength };
    },
    async delete(key) {
      objects.delete(key);
    }
  }
};

const artifact = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const createRequest = new Request('https://example.test/api/pdf-extractions', {
  method: 'POST',
  headers: {
    Origin: 'https://example.test',
    'Content-Type': 'image/png',
    'Content-Length': String(artifact.byteLength),
    'X-PDF-Image-Count': '1',
    'X-PDF-Source-Filename': encodeHeader('lecture.pdf'),
    'X-PDF-Artifact-Filename': encodeHeader('lecture-page-1-image-1.png'),
    'X-PDF-Requested-Json': encodeHeader('{"images":[{"page":1,"position":1}]}')
  },
  body: artifact
});

const createResponse = await handlePdfExtractionRequest(createRequest, env);
assert.equal(createResponse.status, 201);
const created = await createResponse.json();
assert.match(created.jobId, /^[0-9a-f-]{36}$/i);
assert.equal(created.imageCount, 1);
assert.equal(created.filename, 'lecture-page-1-image-1.png');
assert.equal(created.downloadUrl, `https://example.test/api/pdf-extractions/${created.jobId}/download`);
assert.equal(records.size, 1);
assert.equal(objects.size, 1);

const downloadResponse = await handlePdfExtractionRequest(new Request(created.downloadUrl), env);
assert.equal(downloadResponse.status, 200);
assert.equal(downloadResponse.headers.get('Content-Type'), 'image/png');
assert.match(downloadResponse.headers.get('Content-Disposition'), /lecture-page-1-image-1\.png/);
assert.deepEqual(new Uint8Array(await downloadResponse.arrayBuffer()), artifact);

const invalidResponse = await handlePdfExtractionRequest(new Request('https://example.test/api/pdf-extractions', {
  method: 'POST',
  headers: {
    Origin: 'https://example.test',
    'Content-Type': 'text/plain',
    'Content-Length': '3',
    'X-PDF-Image-Count': '1',
    'X-PDF-Source-Filename': encodeHeader('bad.pdf'),
    'X-PDF-Artifact-Filename': encodeHeader('bad.txt')
  },
  body: 'bad'
}), env);
assert.equal(invalidResponse.status, 415);
assert.match((await invalidResponse.json()).error, /PNG or ZIP/);

assert.equal(await handlePdfExtractionRequest(new Request('https://example.test/api/health'), env), null);

console.log('PDF extraction route validation passed.');

function encodeHeader(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

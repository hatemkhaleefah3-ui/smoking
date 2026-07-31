import assert from 'node:assert/strict';
import { applyOpenverseImageSafety } from '../worker/src/image-search-openverse-safety.js';

const response = Response.json({
  resultCount: 4,
  sourceStatus: [
    { source: 'wikimedia', ok: true, count: 1 },
    { source: 'openverse', ok: true, count: 3 }
  ],
  results: [
    {
      id: 'wikimedia:1',
      source: 'wikimedia',
      imageUrl: 'https://upload.wikimedia.org/example.jpg',
      originalUrl: 'https://upload.wikimedia.org/example.jpg'
    },
    {
      id: 'openverse:valid',
      source: 'openverse',
      imageUrl: 'https://api.openverse.org/v1/images/valid/thumb/',
      originalUrl: 'https://images.example.org/primary.jpg'
    },
    {
      id: 'openverse:missing',
      source: 'openverse',
      imageUrl: 'https://api.openverse.org/v1/images/missing/thumb/',
      originalUrl: ''
    },
    {
      id: 'openverse:http',
      source: 'openverse',
      imageUrl: 'https://api.openverse.org/v1/images/http/thumb/',
      originalUrl: 'http://images.example.org/insecure.jpg'
    }
  ]
});

const safeResponse = await applyOpenverseImageSafety(response);
assert.equal(safeResponse.status, 200);
const payload = await safeResponse.json();
assert.equal(payload.resultCount, 2);
assert.equal(payload.results.length, 2);

const openverse = payload.results.find((result) => result.id === 'openverse:valid');
assert.ok(openverse);
assert.equal(openverse.imageUrl, 'https://images.example.org/primary.jpg');
assert.equal(openverse.originalUrl, 'https://images.example.org/primary.jpg');
assert.equal(openverse.thumbnailUrl, 'https://api.openverse.org/v1/images/valid/thumb/');
assert.equal(openverse.openversePrimaryStatus, 'valid-https');
assert.ok(!payload.results.some((result) => result.id === 'openverse:missing'));
assert.ok(!payload.results.some((result) => result.id === 'openverse:http'));

const status = payload.sourceStatus.find((item) => item.source === 'openverse');
assert.equal(status.count, 1);
assert.equal(status.skippedInvalidPrimary, 2);

const nonJson = new Response('plain text', { status: 200, headers: { 'Content-Type': 'text/plain' } });
assert.equal(await applyOpenverseImageSafety(nonJson), nonJson);

console.log('Openverse HTTPS primary validation and thumbnail fallback metadata passed.');

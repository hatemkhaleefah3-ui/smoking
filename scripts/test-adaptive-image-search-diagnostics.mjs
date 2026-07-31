import assert from 'node:assert/strict';
import { searchProviderPool } from '../worker/src/image-search-provider-pool.js';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const commonsQueries = [];
let openIAttempts = 0;

// Compress provider deadlines while preserving AbortController behavior.
globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(Number(delay) || 0, 25), ...args);
globalThis.clearTimeout = (handle) => originalClearTimeout(handle);

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'commons.wikimedia.org') {
    const query = url.searchParams.get('gsrsearch') || '';
    commonsQueries.push(query);
    if (/anatomy/i.test(query)) return Response.json({ query: { pages: [] } });
    return Response.json({ query: { pages: [{
      pageid: 1,
      title: 'File:Human heart.jpg',
      imageinfo: [{
        mime: 'image/jpeg',
        thumburl: 'https://upload.wikimedia.org/heart-thumb.jpg',
        url: 'https://upload.wikimedia.org/heart.jpg',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Human_heart.jpg',
        extmetadata: { ImageDescription: { value: 'Heart anatomy and circulation.' } }
      }]
    }] } });
  }

  if (url.hostname === 'api.openverse.org') {
    return Response.json({ results: [{
      id: 'heart-openverse',
      title: 'Heart physiology',
      description: 'Heart physiology and cardiac contraction.',
      url: 'https://images.openverse.org/heart.jpg',
      thumbnail: 'https://api.openverse.org/v1/images/heart-openverse/thumb/',
      foreign_landing_url: 'https://openverse.org/image/heart-openverse'
    }] });
  }

  if (url.hostname === 'openi.nlm.nih.gov') {
    openIAttempts += 1;
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }

  throw new Error(`Unexpected URL ${url.href}`);
};

try {
  const startedAt = Date.now();
  const payload = await searchProviderPool({ query: 'Heart', suffix: 'anatomy', debug: true });
  const durationMs = Date.now() - startedAt;

  assert.deepEqual(commonsQueries, ['Heart anatomy', 'Heart']);
  const wikimedia = payload.sourceStatus.find((item) => item.source === 'wikimedia');
  assert.equal(wikimedia.ok, true);
  assert.equal(wikimedia.count, 1);
  assert.equal(wikimedia.fallbackUsed, true);
  assert.equal(wikimedia.fallbackQuery, 'Heart');
  assert.equal(wikimedia.topicQueryCount, 0);

  const openverse = payload.sourceStatus.find((item) => item.source === 'openverse');
  assert.equal(openverse.ok, true);
  assert.equal(openverse.count, 1);

  const openI = payload.sourceStatus.find((item) => item.source === 'nlm-open-i');
  assert.equal(openIAttempts, 2, 'NLM Open-i should receive exactly one retry.');
  assert.equal(openI.ok, false);
  assert.equal(openI.skipped, true);
  assert.equal(openI.timedOut, true);
  assert.match(openI.message, /NLM Open-i timed out, showing other sources/i);
  assert.ok(durationMs < 500, 'A timed-out provider must not stall other providers in the accelerated test.');
  assert.equal(payload.results.length, 2, 'Healthy providers must still return results.');
  assert.ok(payload.diagnostics.some((item) => item.source === 'nlm-open-i' && item.timedOut));

  console.log('Wikimedia base-query fallback, Promise.allSettled isolation and Open-i timeout retry passed.');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

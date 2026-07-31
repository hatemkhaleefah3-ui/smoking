import assert from 'node:assert/strict';
import { handleImageSearchRequest, rankResults } from '../worker/src/image-search.js';

const ranked = rankResults([
  { id: 'neutral', source: 'wikimedia', sourceLabel: 'Wikimedia', imageUrl: 'https://example.test/neutral.jpg' },
  { id: 'up-one', source: 'openverse', sourceLabel: 'Openverse', imageUrl: 'https://example.test/up-one.jpg' },
  { id: 'up-two', source: 'openverse', sourceLabel: 'Openverse', imageUrl: 'https://example.test/up-two.jpg' },
  { id: 'down-one', source: 'openverse', sourceLabel: 'Openverse', imageUrl: 'https://example.test/down-one.jpg' },
  { id: 'down-two', source: 'openverse', sourceLabel: 'Openverse', imageUrl: 'https://example.test/down-two.jpg' },
  { id: 'down-three', source: 'openverse', sourceLabel: 'Openverse', imageUrl: 'https://example.test/down-three.jpg' }
], new Map([
  ['https://example.test/up-one.jpg', 1],
  ['https://example.test/up-two.jpg', 2],
  ['https://example.test/down-one.jpg', -1],
  ['https://example.test/down-two.jpg', -2],
  ['https://example.test/down-three.jpg', -3]
]), new Set(), null);

assert.deepEqual(ranked.map((item) => item.id), [
  'up-two', 'up-one', 'neutral', 'down-one', 'down-two'
]);
assert.ok(!ranked.some((item) => item.id === 'down-three'));
assert.equal(ranked.find((item) => item.id === 'down-two').feedbackScore, -2);

const originalFetch = globalThis.fetch;
const db = createD1();
const env = { DB: db, LECTURES: createR2() };

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'www.wikidata.org') {
    const action = url.searchParams.get('action');
    if (action === 'wbsearchentities') {
      return Response.json({ search: [{ id: 'Q5', label: 'glycine', description: 'amino acid, neurotransmitter and nutrient' }] });
    }
    if (url.searchParams.get('ids') === 'Q5') {
      return Response.json({ entities: { Q5: {
        id: 'Q5',
        labels: { en: { value: 'glycine' } },
        descriptions: { en: { value: 'amino acid and inhibitory neurotransmitter used in metabolism' } },
        claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q11173' } } } }] }
      } } });
    }
    return Response.json({ entities: { Q11173: {
      labels: { en: { value: 'chemical compound' } },
      descriptions: { en: { value: 'molecular chemical entity' } }
    } } });
  }

  if (url.hostname === 'commons.wikimedia.org') {
    return Response.json({ query: { pages: {
      1: {
        pageid: 1,
        title: 'File:Glycine structure.svg',
        imageinfo: [{
          mime: 'image/svg+xml',
          thumburl: 'https://upload.wikimedia.org/glycine.png',
          url: 'https://upload.wikimedia.org/glycine.svg',
          descriptionurl: 'https://commons.wikimedia.org/wiki/File:Glycine_structure.svg',
          extmetadata: { ImageDescription: { value: 'Glycine structure' } }
        }]
      }
    } } });
  }

  if (url.hostname === 'api.openverse.org') {
    return Response.json({ result_count: 0, results: [] });
  }

  if (url.hostname === 'openi.nlm.nih.gov') {
    return new Response('<html><h1>The web site is currently under maintenance.</h1></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  throw new Error(`Unexpected URL: ${url}`);
};

try {
  const ambiguousResponse = await handleImageSearchRequest(request({ query: 'glycine', debug: true }), env);
  const ambiguous = await ambiguousResponse.json();
  assert.equal(ambiguous.requiresTopic, true);
  assert.ok(ambiguous.topics.length >= 2);
  assert.ok(ambiguous.debugDiagnostics.wikidata.length >= 3);
  assert.match(ambiguous.debugDiagnostics.wikidata[0].rawResponseBody, /neurotransmitter/);

  const selected = ambiguous.topics[0];
  const searchResponse = await handleImageSearchRequest(request({ query: 'glycine', topic: selected, debug: true }), env);
  const payload = await searchResponse.json();
  assert.equal(payload.requiresTopic, false);
  assert.equal(payload.feedbackRanking.method, 'net-score');
  assert.equal(payload.feedbackRanking.negativeRemovalThreshold, -3);
  assert.ok(payload.sourceStatus.some((item) => item.source === 'wikimedia' && item.count === 1));
  assert.ok(payload.sourceStatus.some((item) => item.source === 'nlm-open-i' && item.ok === false));
  const nlmDiagnostic = payload.debugDiagnostics.providers.find((item) => item.source === 'nlm-open-i');
  assert.equal(nlmDiagnostic.status, 200);
  assert.match(nlmDiagnostic.rawResponseBody, /under maintenance/);
  assert.ok(payload.results.some((item) => item.source === 'wikimedia'));

  console.log('Adaptive provider diagnostics, Wikidata ambiguity and proportional ranking passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function request(body) {
  return new Request('https://example.test/api/image-search', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function createD1() {
  return {
    async batch(statements) { return statements.map(() => ({ success: true, results: [] })); },
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    }
  };
}

function createR2() {
  const values = new Map();
  return {
    async get(key) {
      const value = values.get(key);
      return value == null ? null : { async text() { return value; } };
    },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); }
  };
}

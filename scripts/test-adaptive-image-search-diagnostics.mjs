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
const requestHeaders = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = new Headers(init.headers || {});
  requestHeaders.push({ url: url.href, userAgent: headers.get('User-Agent'), apiUserAgent: headers.get('Api-User-Agent') });

  if (url.hostname === 'www.wikidata.org') {
    const action = url.searchParams.get('action');
    if (action === 'wbsearchentities') {
      return Response.json({
        search: [
          { id: 'Q5', label: 'glycine', description: 'amino acid, neurotransmitter and nutrient' },
          { id: 'Q6', label: 'Glycine', description: 'plant genus including soybean' }
        ]
      });
    }
    if (url.searchParams.get('ids') === 'Q5|Q6') {
      return Response.json({ entities: {
        Q5: {
          id: 'Q5',
          labels: { en: { value: 'glycine' } },
          descriptions: { en: { value: 'amino acid and inhibitory neurotransmitter used in metabolism' } },
          claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q11173' } } } }] }
        },
        Q6: {
          id: 'Q6',
          labels: { en: { value: 'Glycine' } },
          descriptions: { en: { value: 'plant genus including soybean' } },
          claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q34740' } } } }] }
        }
      } });
    }
    return Response.json({ entities: {
      Q11173: {
        labels: { en: { value: 'chemical compound' } },
        descriptions: { en: { value: 'molecular chemical entity' } }
      },
      Q34740: {
        labels: { en: { value: 'genus' } },
        descriptions: { en: { value: 'taxonomic rank for plants' } }
      }
    } });
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
    return Response.json({
      count: 1,
      total: 1,
      list: [{
        uid: 'PMC3846451',
        pmcid: '3846451',
        title: 'Identification of a single amino acid in GluN1 that is critical for glycine-primed internalization.',
        authors: 'Han L, Campanucci VA, Cooke J, Salter MW',
        journal_title: 'Molecular brain',
        image: {
          id: 'F5',
          caption: 'Mutant GluN1 receptors did not show <b>glycine</b> priming.'
        },
        imgThumb: '/imgs/100/59/3846451/example.png',
        imgLarge: '/imgs/512/59/3846451/example.png',
        detailedQueryURL: '/search?img=PMC3846451_example&query=glycine&req=4'
      }]
    });
  }

  throw new Error(`Unexpected URL: ${url}`);
};

try {
  const ambiguousResponse = await handleImageSearchRequest(request({ query: 'glycine', debug: true }), env);
  const ambiguous = await ambiguousResponse.json();
  assert.equal(ambiguous.requiresTopic, true);
  assert.ok(ambiguous.topics.length >= 2);
  assert.ok(ambiguous.topics.some((topic) => topic.id === 'chemical-structure'));
  assert.ok(ambiguous.topics.some((topic) => topic.id === 'botany'));
  assert.ok(ambiguous.debugDiagnostics.wikidata.length >= 3);
  assert.match(ambiguous.debugDiagnostics.wikidata[0].rawResponseBody, /neurotransmitter/);

  const selected = ambiguous.topics.find((topic) => topic.id === 'chemical-structure');
  const searchResponse = await handleImageSearchRequest(request({ query: 'glycine', topic: selected, debug: true }), env);
  const payload = await searchResponse.json();
  assert.equal(payload.requiresTopic, false);
  assert.equal(payload.feedbackRanking.method, 'net-score');
  assert.equal(payload.feedbackRanking.negativeRemovalThreshold, -3);
  assert.ok(payload.sourceStatus.some((item) => item.source === 'wikimedia' && item.count === 1));
  assert.ok(payload.sourceStatus.some((item) => item.source === 'nlm-open-i' && item.count === 1));
  const nlm = payload.results.find((item) => item.source === 'nlm-open-i');
  assert.ok(nlm);
  assert.equal(nlm.imageUrl, 'https://openi.nlm.nih.gov/imgs/512/59/3846451/example.png');
  assert.notEqual(nlm.imageUrl, 'https://openi.nlm.nih.gov/');
  assert.equal(nlm.id, 'nlm-open-i:PMC3846451:F5');
  assert.match(nlm.caption, /glycine priming/);
  assert.equal(nlm.creator, 'Han L, Campanucci VA, Cooke J, Salter MW');

  assert.ok(requestHeaders.length >= 6);
  assert.ok(requestHeaders.every((entry) => entry.userAgent?.includes('LectureStudioImageSearch/1.2')));
  assert.ok(requestHeaders.every((entry) => entry.apiUserAgent?.includes('LectureStudioImageSearch/1.2')));

  console.log('Adaptive provider headers, Open-i fields, Wikidata ambiguity and proportional ranking passed.');
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

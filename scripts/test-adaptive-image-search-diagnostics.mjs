import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  handleImageSearchRequest,
  rankResults
} from '../worker/src/image-search.js';

const ranked = rankResults([
  { id: 'neutral', imageUrl: 'https://example.test/neutral.jpg', sourceLabel: 'Neutral' },
  { id: 'up', imageUrl: 'https://example.test/up.jpg', sourceLabel: 'Up' },
  { id: 'down', imageUrl: 'https://example.test/down.jpg', sourceLabel: 'Down' },
  { id: 'removed', imageUrl: 'https://example.test/removed.jpg', sourceLabel: 'Removed' }
], new Map([
  ['https://example.test/up.jpg', 2],
  ['https://example.test/down.jpg', -2],
  ['https://example.test/removed.jpg', -3]
]), new Set(), null);

assert.deepEqual(ranked.map((item) => item.id), ['up', 'neutral', 'down']);
assert.equal(ranked.find((item) => item.id === 'down').feedbackScore, -2);

const originalFetch = globalThis.fetch;
let mode = 'heart';
let heartOpenIAttempt = 0;
let nutritionOpenIAttempt = 0;

globalThis.fetch = async (input) => {
  const url = new URL(String(input));

  if (url.hostname === 'www.wikidata.org') {
    const action = url.searchParams.get('action');
    if (action === 'wbsearchentities') {
      const query = url.searchParams.get('search');
      if (query.toLowerCase() === 'heart') {
        return Response.json({
          search: [{ id: 'Q-heart', label: 'heart', description: 'organ of the circulatory system' }]
        });
      }
      return Response.json({
        search: [
          { id: 'Q-glycine', label: 'glycine', description: 'amino acid, neurotransmitter and metabolite' },
          { id: 'Q-plant', label: 'Glycine', description: 'genus of plants including soybean' }
        ]
      });
    }

    const ids = url.searchParams.get('ids');
    if (ids === 'Q-heart') {
      return Response.json({
        entities: {
          'Q-heart': {
            id: 'Q-heart',
            labels: { en: { value: 'heart' } },
            descriptions: { en: { value: 'organ of the circulatory system' } },
            claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q-organ' } } } }] }
          }
        }
      });
    }
    if (ids === 'Q-glycine|Q-plant') {
      return Response.json({
        entities: {
          'Q-glycine': {
            id: 'Q-glycine',
            labels: { en: { value: 'glycine' } },
            descriptions: { en: { value: 'amino acid, neurotransmitter and metabolite' } },
            claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q-chemical' } } } }] }
          },
          'Q-plant': {
            id: 'Q-plant',
            labels: { en: { value: 'Glycine' } },
            descriptions: { en: { value: 'plant genus including soybean' } },
            claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q-genus' } } } }] }
          }
        }
      });
    }
    return Response.json({ entities: {} });
  }

  if (url.hostname === 'commons.wikimedia.org') {
    const query = url.searchParams.get('gsrsearch');
    if (query !== 'Heart' && query !== 'glycine') {
      return Response.json({ query: { pages: [] } });
    }
    return Response.json({
      query: {
        pages: [{
          pageid: query === 'Heart' ? 1 : 2,
          title: `File:${query}.jpg`,
          imageinfo: [{
            mime: 'image/jpeg',
            thumburl: `https://upload.wikimedia.org/${query.toLowerCase()}.jpg`,
            url: `https://upload.wikimedia.org/${query.toLowerCase()}-original.jpg`,
            descriptionurl: `https://commons.wikimedia.org/wiki/File:${query}.jpg`,
            extmetadata: {
              ImageDescription: { value: `${query} educational image` }
            }
          }]
        }]
      }
    });
  }

  if (url.hostname === 'api.openverse.org') {
    return Response.json({ result_count: 0, results: [] });
  }

  if (url.hostname === 'openi.nlm.nih.gov') {
    const query = url.searchParams.get('query');

    if (mode === 'heart') {
      heartOpenIAttempt += 1;
      if (heartOpenIAttempt === 1) throw new DOMException('Timed out', 'AbortError');
      return Response.json({
        count: 1,
        list: [{
          uid: 'PMC-heart',
          title: 'Heart anatomy',
          authors: 'Example Author',
          image: { id: 'F1', caption: 'Heart anatomy figure' },
          imgLarge: '/imgs/512/heart.png'
        }]
      });
    }

    if (mode === 'nutrition-timeout') {
      nutritionOpenIAttempt += 1;
      throw new DOMException(`Timed out ${query}`, 'AbortError');
    }
  }

  throw new Error(`Unexpected mock URL: ${url.href}`);
};

const env = {
  DB: createD1(),
  LECTURES: null
};

try {
  const heartResponse = await handleImageSearchRequest(request({
    query: 'Heart',
    retry: true,
    debug: true
  }), env);
  assert.equal(heartResponse.status, 200);
  const heart = await heartResponse.json();

  assert.equal(heart.requiresTopic, false);
  assert.equal(heart.externalQuery, 'Heart anatomy clinical medical image');
  assert.ok(heart.results.some((item) => item.source === 'wikimedia'));
  assert.ok(heart.results.some((item) => item.source === 'nlm-open-i'));

  const wikimedia = heart.sourceStatus.find((item) => item.source === 'wikimedia');
  assert.equal(wikimedia.ok, true);
  assert.equal(wikimedia.fallbackUsed, true);
  assert.equal(wikimedia.fallbackQuery, 'Heart');
  assert.equal(wikimedia.topicQueryCount, 0);

  const nlmHeart = heart.sourceStatus.find((item) => item.source === 'nlm-open-i');
  assert.equal(nlmHeart.ok, true);
  assert.equal(nlmHeart.fallbackUsed, true);
  assert.equal(nlmHeart.fallbackQuery, 'Heart');
  assert.equal(heartOpenIAttempt, 2);
  assert.ok(heart.debugDiagnostics.providers.some((item) =>
    item.source === 'nlm-open-i' && item.timedOut === true));
  assert.ok(heart.debugDiagnostics.providers.some((item) =>
    item.source === 'wikimedia' && item.stage === 'base-query-fallback'));

  mode = 'nutrition-timeout';
  const ambiguityResponse = await handleImageSearchRequest(request({
    query: 'glycine',
    retry: true,
    debug: true
  }), env);
  const ambiguity = await ambiguityResponse.json();
  assert.equal(ambiguity.requiresTopic, true);
  assert.deepEqual(ambiguity.topics.map((topic) => topic.id), [
    'chemical-structure',
    'medical-neurological',
    'nutrition-metabolism',
    'botany'
  ]);

  const nutrition = ambiguity.topics.find((topic) => topic.id === 'nutrition-metabolism');
  const nutritionResponse = await handleImageSearchRequest(request({
    query: 'glycine',
    topic: nutrition,
    retry: true,
    debug: true
  }), env);
  assert.equal(nutritionResponse.status, 200);
  const nutritionPayload = await nutritionResponse.json();

  assert.ok(nutritionPayload.results.some((item) => item.source === 'wikimedia'));
  const nlmNutrition = nutritionPayload.sourceStatus.find((item) => item.source === 'nlm-open-i');
  assert.equal(nlmNutrition.ok, false);
  assert.equal(nlmNutrition.timedOut, true);
  assert.equal(nlmNutrition.skipped, true);
  assert.match(nlmNutrition.message, /timed out, showing other sources/i);
  assert.equal(nutritionOpenIAttempt, 2);
  assert.equal(nutritionPayload.providerSummary.partial, true);
  assert.ok(nutritionPayload.providerSummary.timedOut.includes('nlm-open-i'));

  const frontend = await readFile(new URL('../adaptive-image-search.js', import.meta.url), 'utf8');
  assert.match(frontend, /AbortController/);
  assert.match(frontend, /SEARCH_TIMEOUT_MS/);
  assert.match(frontend, /finally\s*\{/);
  assert.match(frontend, /setLoading\(false\)/);
  assert.match(frontend, /timed out · other sources shown/);
  assert.match(frontend, /No results found/);

  console.log('Adaptive provider fallback, timeout isolation and spinner recovery validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function request(body) {
  return new Request('https://example.test/api/image-search', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

function createD1() {
  return {
    async batch(statements) {
      return statements.map(() => ({ success: true, results: [] }));
    },
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    }
  };
}

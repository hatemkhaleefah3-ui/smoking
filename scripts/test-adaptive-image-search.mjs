import assert from 'node:assert/strict';
import { handleImageSearchRequest } from '../worker/src/image-search.js';

const originalFetch = globalThis.fetch;
const feedbackRows = [
  {
    image_url: 'https://openi.nlm.nih.gov/imgs/glycine-neuro.png',
    source: 'nlm-open-i',
    query_term: 'glycine',
    topic: 'Medical / neurological',
    rating: 1
  },
  {
    image_url: 'https://images.openverse.org/unrelated-glycine.jpg',
    source: 'openverse',
    query_term: 'glycine',
    topic: 'Medical / neurological',
    rating: -1
  }
];
const db = createD1(feedbackRows);
const cache = createR2();
const env = {
  DB: db,
  LECTURES: cache,
  IMAGE_SEARCH_CACHE_TTL_SECONDS: '604800'
};

let providerCallCount = 0;
let wikidataCallCount = 0;

globalThis.fetch = async (input) => {
  const url = new URL(String(input));

  if (url.hostname === 'www.wikidata.org') {
    wikidataCallCount += 1;
    const action = url.searchParams.get('action');
    if (action === 'wbsearchentities') {
      return Response.json({
        search: [
          { id: 'Q1', label: 'glycine', description: 'amino acid, neurotransmitter and nutrient' }
        ]
      });
    }
    if (action === 'wbgetentities' && url.searchParams.get('ids') === 'Q1') {
      return Response.json({
        entities: {
          Q1: {
            id: 'Q1',
            labels: { en: { value: 'glycine' } },
            descriptions: { en: { value: 'amino acid, neurotransmitter and nutrient used in metabolism' } },
            claims: {
              P31: [
                { mainsnak: { datavalue: { value: { id: 'Q2' } } } }
              ]
            }
          }
        }
      });
    }
    if (action === 'wbgetentities' && url.searchParams.get('ids') === 'Q2') {
      return Response.json({
        entities: {
          Q2: {
            id: 'Q2',
            labels: { en: { value: 'chemical compound' } },
            descriptions: { en: { value: 'molecular chemical entity' } }
          }
        }
      });
    }
  }

  providerCallCount += 1;
  if (url.hostname === 'commons.wikimedia.org') {
    return Response.json({
      query: {
        pages: [
          {
            pageid: 10,
            title: 'File:Glycine neurotransmission diagram.svg',
            imageinfo: [
              {
                mime: 'image/svg+xml',
                thumburl: 'https://upload.wikimedia.org/glycine-neuro.png',
                url: 'https://upload.wikimedia.org/glycine-neuro.svg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Glycine_neurotransmission_diagram.svg',
                thumbwidth: 960,
                thumbheight: 640,
                extmetadata: {
                  ImageDescription: { value: 'Glycine neurotransmission pathway' },
                  Artist: { value: 'Example author' },
                  LicenseShortName: { value: 'CC BY-SA 4.0' },
                  LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
                }
              }
            ]
          }
        ]
      }
    });
  }

  if (url.hostname === 'api.openverse.org') {
    return Response.json({
      results: [
        {
          id: 'ov-1',
          title: 'Unrelated glycine photograph',
          thumbnail: 'https://images.openverse.org/unrelated-glycine.jpg',
          url: 'https://images.openverse.org/unrelated-glycine-full.jpg',
          foreign_landing_url: 'https://openverse.org/image/ov-1',
          creator: 'Example creator',
          license: 'by',
          license_url: 'https://creativecommons.org/licenses/by/4.0/'
        }
      ]
    });
  }

  if (url.hostname === 'openi.nlm.nih.gov') {
    return Response.json({
      list: [
        {
          imgId: 'PMC-glycine-1',
          imgUrl: '/imgs/glycine-neuro.png',
          title: 'Glycine as an inhibitory neurotransmitter',
          caption: 'Clinical diagram of glycine signaling in the nervous system.',
          journal: 'Example medical journal',
          license: 'CC BY'
        }
      ]
    });
  }

  return Response.json({ error: 'Unexpected mock URL' }, { status: 404 });
};

try {
  const ambiguousResponse = await handleImageSearchRequest(searchRequest({ query: 'glycine' }), env);
  assert.equal(ambiguousResponse.status, 200);
  const ambiguous = await ambiguousResponse.json();
  assert.equal(ambiguous.requiresTopic, true);
  assert.ok(ambiguous.topics.length >= 2);
  assert.ok(ambiguous.topics.some((topic) => topic.id === 'chemical-structure'));
  assert.ok(ambiguous.topics.some((topic) => topic.id === 'medical-neurological'));
  assert.ok(ambiguous.topics.some((topic) => topic.id === 'nutrition-metabolism'));
  assert.equal(providerCallCount, 0, 'Image providers must not run before an ambiguous topic is selected.');
  assert.ok(wikidataCallCount >= 3);

  const selectedTopic = {
    id: 'medical-neurological',
    label: 'Medical / neurological',
    querySuffix: 'medical neurological neurotransmitter'
  };
  const firstSearchResponse = await handleImageSearchRequest(searchRequest({
    query: 'glycine',
    topic: selectedTopic
  }), env);
  assert.equal(firstSearchResponse.status, 200);
  const firstSearch = await firstSearchResponse.json();
  assert.equal(firstSearch.requiresTopic, false);
  assert.equal(firstSearch.cacheHit, false);
  assert.equal(firstSearch.topic.id, 'medical-neurological');
  assert.equal(firstSearch.results[0].source, 'nlm-open-i', 'Previously upvoted images should rank first.');
  assert.ok(firstSearch.results.every((result) => result.imageUrl !== 'https://images.openverse.org/unrelated-glycine.jpg'), 'Previously downvoted images should be filtered.');
  assert.ok(firstSearch.sourceStatus.some((item) => item.source === 'wikimedia' && item.ok));
  assert.ok(firstSearch.sourceStatus.some((item) => item.source === 'openverse' && item.ok));
  assert.ok(firstSearch.sourceStatus.some((item) => item.source === 'nlm-open-i' && item.ok));
  assert.equal(cache.objects.size, 1, 'Successful metadata should be cached in R2.');

  const callsAfterFreshSearch = providerCallCount;
  const cachedSearchResponse = await handleImageSearchRequest(searchRequest({
    query: 'glycine',
    topic: selectedTopic
  }), env);
  const cachedSearch = await cachedSearchResponse.json();
  assert.equal(cachedSearch.cacheHit, true);
  assert.equal(providerCallCount, callsAfterFreshSearch, 'A cache hit should avoid external image-provider calls.');

  const retryResponse = await handleImageSearchRequest(searchRequest({
    query: 'glycine',
    topic: selectedTopic,
    retry: true,
    excludeUrls: ['https://openi.nlm.nih.gov/imgs/glycine-neuro.png']
  }), env);
  const retry = await retryResponse.json();
  assert.equal(retry.cacheHit, false);
  assert.ok(retry.results.every((result) => result.imageUrl !== 'https://openi.nlm.nih.gov/imgs/glycine-neuro.png'));
  assert.ok(providerCallCount > callsAfterFreshSearch, 'Retry should fetch fresh provider results.');

  const feedbackResponse = await handleImageSearchRequest(feedbackRequest({
    imageUrl: 'https://upload.wikimedia.org/glycine-neuro.png',
    source: 'wikimedia',
    queryTerm: 'glycine',
    topic: 'Medical / neurological',
    rating: 1
  }), env);
  assert.equal(feedbackResponse.status, 201);
  assert.equal((await feedbackResponse.json()).saved, true);
  assert.ok(feedbackRows.some((row) => row.image_url === 'https://upload.wikimedia.org/glycine-neuro.png' && row.rating === 1));

  console.log('Adaptive image search ambiguity, ranking, feedback, retry and cache validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function searchRequest(body) {
  return new Request('https://example.test/api/image-search', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

function feedbackRequest(body) {
  return new Request('https://example.test/api/image-search/feedback', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

function createD1(rows) {
  return {
    async batch(statements) {
      return statements.map(() => ({ success: true, results: [] }));
    },
    prepare(sql) {
      return statement(sql, []);
    }
  };

  function statement(sql, values) {
    return {
      bind(...nextValues) {
        return statement(sql, nextValues);
      },
      async all() {
        if (!/SELECT image_url, SUM\(rating\)/.test(sql)) return { results: [] };
        const [queryTerm, topic] = values;
        const relevant = rows.filter((row) => {
          const queryMatches = row.query_term.toLowerCase() === String(queryTerm || '').toLowerCase();
          const topicMatches = /topic IS NULL/.test(sql)
            ? row.topic == null
            : String(row.topic || '').toLowerCase() === String(topic || '').toLowerCase();
          return queryMatches && topicMatches;
        });
        const aggregate = new Map();
        for (const row of relevant) aggregate.set(row.image_url, Number(aggregate.get(row.image_url) || 0) + Number(row.rating));
        return { results: [...aggregate].map(([image_url, score]) => ({ image_url, score })) };
      },
      async run() {
        if (/INSERT INTO image_feedback/.test(sql)) {
          const [image_url, source, query_term, topic, rating] = values;
          rows.push({ image_url, source, query_term, topic, rating });
        }
        return { success: true };
      }
    };
  }
}

function createR2() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      const value = objects.get(key);
      if (value == null) return null;
      return { async text() { return value; } };
    },
    async put(key, body) {
      objects.set(key, String(body));
      return { size: String(body).length };
    },
    async delete(key) {
      objects.delete(key);
    }
  };
}

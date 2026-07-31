import assert from 'node:assert/strict';
import { handleImageSearchRequest } from '../worker/src/image-search.js';

const originalFetch = globalThis.fetch;
const db = createD1();
const cache = createR2();
const env = { DB: db, LECTURES: cache, IMAGE_SEARCH_CACHE_TTL_SECONDS: '604800' };
let providerCalls = 0;

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'www.wikidata.org') throw new Error('Static Wikidata disambiguation must not run.');
  providerCalls += 1;

  if (url.hostname === 'commons.wikimedia.org') {
    return Response.json({ query: { pages: [
      commonsPage(1, 'Heart structure chambers', 'Heart human structure includes chambers and valves.'),
      commonsPage(2, 'Heart structure ventricles', 'Heart human structure includes atria and ventricles.'),
      commonsPage(3, 'Heart structure anatomy', 'Heart human structure includes myocardium and septum.')
    ] } });
  }

  if (url.hostname === 'api.openverse.org') {
    return Response.json({ results: [
      openverseItem('physiology-1', 'Heart physiology circulation', 'Heart human physiology controls blood circulation.'),
      openverseItem('physiology-2', 'Heart physiology contraction', 'Heart human physiology describes cardiac contraction.')
    ] });
  }

  if (url.hostname === 'openi.nlm.nih.gov') {
    return Response.json({ list: [
      openIItem('valve-1', 'Heart valve disease', 'Heart human valve disease affects blood flow.'),
      openIItem('valve-2', 'Heart valve anatomy', 'Heart human valve anatomy is described clinically.')
    ] });
  }

  return Response.json({ error: 'Unexpected mock URL' }, { status: 404 });
};

try {
  const initialResponse = await handleImageSearchRequest(searchRequest({ query: 'Heart' }), env);
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.requiresTopic, false);
  assert.equal(initial.requiresKeyword, true);
  assert.equal(initial.poolResultCount, 7);
  assert.ok(initial.keywordOptions.length >= 3);
  assert.ok(initial.keywordOptions.some((item) => item.keyword === 'structure'));
  assert.ok(initial.keywordOptions.some((item) => item.keyword === 'physiology' || item.keyword === 'physiolog'));
  assert.ok(initial.keywordOptions.some((item) => item.keyword === 'valve'));
  assert.ok(!initial.keywordOptions.some((item) => item.keyword === 'human'), 'Generic high-overlap “human” must be removed.');
  assert.ok(initial.keywordExtraction.genericDropped >= 1);
  assert.equal(cache.objects.size, 1);

  const callsAfterInitial = providerCalls;
  const physiology = initial.keywordOptions.find((item) => item.keyword === 'physiology' || item.keyword === 'physiolog');
  const physiologyResponse = await handleImageSearchRequest(searchRequest({ query: 'Heart', keyword: physiology }), env);
  const physiologyPayload = await physiologyResponse.json();
  assert.equal(physiologyPayload.cacheHit, true);
  assert.equal(providerCalls, callsAfterInitial, 'Keyword filtering must reuse the broad cached pool.');
  assert.equal(physiologyPayload.requiresKeyword, false);
  assert.equal(physiologyPayload.resultCount, 2);
  assert.equal(physiologyPayload.filter.fallbackUsed, true);
  assert.equal(physiologyPayload.filter.mode, 'title-caption');
  assert.ok(physiologyPayload.keywordOptions.some((item) => item.keyword === 'structure'), 'Other overlapping options must remain visible.');
  assert.ok(physiologyPayload.results.every((item) => /physiology/i.test(`${item.title} ${item.caption}`)));

  const structure = initial.keywordOptions.find((item) => item.keyword === 'structure');
  const valve = initial.keywordOptions.find((item) => item.keyword === 'valve');
  const structureBefore = await jsonOf(handleImageSearchRequest(searchRequest({ query: 'Heart', keyword: structure }), env));
  assert.equal(structureBefore.resultCount, 3);
  const liked = structureBefore.results[0];
  const similarUnrated = structureBefore.results[1];

  for (let index = 0; index < 3; index += 1) {
    const response = await handleImageSearchRequest(feedbackRequest({
      imageUrl: liked.imageUrl,
      source: liked.source,
      queryTerm: 'Heart',
      topic: structure.label,
      topicCluster: structure.keyword,
      rating: 1,
      title: liked.title,
      caption: liked.caption,
      creator: liked.creator,
      collection: liked.collection,
      keywords: liked.significantKeywords
    }), env);
    assert.equal(response.status, 201);
  }

  const valveBefore = await jsonOf(handleImageSearchRequest(searchRequest({ query: 'Heart', keyword: valve }), env));
  const disliked = valveBefore.results[0];
  for (let index = 0; index < 5; index += 1) {
    const response = await handleImageSearchRequest(feedbackRequest({
      imageUrl: disliked.imageUrl,
      source: disliked.source,
      queryTerm: 'Heart',
      topic: valve.label,
      topicCluster: valve.keyword,
      rating: -1,
      title: disliked.title,
      caption: disliked.caption,
      creator: disliked.creator,
      collection: disliked.collection,
      keywords: disliked.significantKeywords
    }), env);
    assert.equal(response.status, 201);
  }

  const structureAfter = await jsonOf(handleImageSearchRequest(searchRequest({ query: 'Heart', keyword: structure }), env));
  assert.equal(structureAfter.results[0].imageUrl, liked.imageUrl, 'Liked image should move toward the top.');
  const propagated = structureAfter.results.find((item) => item.imageUrl === similarUnrated.imageUrl);
  assert.ok(propagated);
  assert.ok(propagated.similarityFeedbackScore > 0, 'A similar unrated image should receive fractional positive propagation.');

  const valveAfter = await jsonOf(handleImageSearchRequest(searchRequest({ query: 'Heart', keyword: valve }), env));
  assert.ok(valveAfter.results.some((item) => item.imageUrl === disliked.imageUrl), 'Heavily disliked images must remain in the pool.');
  assert.equal(valveAfter.results.at(-1).imageUrl, disliked.imageUrl, 'Heavily disliked image should be gradually demoted.');
  assert.equal(valveAfter.feedbackRanking.hardRemovalThreshold, null);

  console.log('Data-driven keyword extraction, overlap handling, progressive fallback, persistent feedback and similarity propagation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function commonsPage(id, title, caption) {
  return {
    pageid: id,
    title: `File:${title}.svg`,
    imageinfo: [{
      mime: 'image/svg+xml',
      thumburl: `https://upload.wikimedia.org/${id}.png`,
      url: `https://upload.wikimedia.org/${id}.svg`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${id}.svg`,
      extmetadata: {
        ImageDescription: { value: caption },
        Artist: { value: 'Anatomy Lab' },
        LicenseShortName: { value: 'CC BY-SA 4.0' }
      }
    }]
  };
}

function openverseItem(id, title, description) {
  return {
    id,
    title,
    description,
    url: `https://images.openverse.org/${id}.jpg`,
    thumbnail: `https://api.openverse.org/v1/images/${id}/thumb/`,
    foreign_landing_url: `https://openverse.org/image/${id}`,
    creator: 'Physiology Lab',
    provider: 'example-collection',
    license: 'by',
    license_url: 'https://creativecommons.org/licenses/by/4.0/'
  };
}

function openIItem(id, title, caption) {
  return {
    uid: id,
    title,
    authors: 'Clinical Team',
    journal_title: 'Heart Journal',
    image: { id: 'F1', caption },
    imgLarge: `/imgs/512/${id}.png`,
    detailedQueryURL: `/search?img=${id}&query=heart&req=4`
  };
}

function searchRequest(body) {
  return new Request('https://example.test/api/image-search', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function feedbackRequest(body) {
  return new Request('https://example.test/api/image-search/feedback', {
    method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function jsonOf(responsePromise) {
  const response = await responsePromise;
  assert.equal(response.status, 200);
  return response.json();
}

function createD1() {
  const events = [];
  const profiles = new Map();
  return {
    events,
    profiles,
    async batch(statements) { return statements.map(() => ({ success: true, results: [] })); },
    prepare(sql) { return statement(sql, []); }
  };

  function statement(sql, values) {
    return {
      bind(...nextValues) { return statement(sql, nextValues); },
      async all() {
        if (/SELECT score FROM image_feedback_profiles/.test(sql)) {
          const profile = profiles.get(values[0]);
          return { results: profile ? [{ score: profile.score }] : [] };
        }
        if (/SELECT COALESCE\(SUM\(rating\)/.test(sql)) {
          const score = events.filter((row) => row.image_url === values[0]).reduce((sum, row) => sum + row.rating, 0);
          return { results: [{ score }] };
        }
        if (/FROM image_feedback_profiles/.test(sql) && /WHERE score != 0/.test(sql)) {
          return { results: [...profiles.values()].filter((row) => row.score !== 0) };
        }
        if (/FROM image_feedback\s+GROUP BY image_url/.test(sql)) {
          const aggregate = new Map();
          for (const row of events) aggregate.set(row.image_url, Number(aggregate.get(row.image_url) || 0) + row.rating);
          return { results: [...aggregate].filter(([, score]) => score !== 0).map(([image_url, score]) => ({ image_url, score })) };
        }
        return { results: [] };
      },
      async run() {
        if (/INSERT INTO image_feedback \(/.test(sql)) {
          const [image_url, source, query_term, topic, rating] = values;
          events.push({ image_url, source, query_term, topic, rating: Number(rating) });
        } else if (/UPDATE image_feedback_profiles/.test(sql)) {
          const [source, creator, collection_name, title, caption, keywords_json, topic_cluster, score, image_url] = values;
          profiles.set(image_url, { image_url, source, creator, collection_name, title, caption, keywords_json, topic_cluster, score: Number(score) });
        } else if (/INSERT INTO image_feedback_profiles/.test(sql)) {
          const [image_url, source, creator, collection_name, title, caption, keywords_json, topic_cluster, score] = values;
          profiles.set(image_url, { image_url, source, creator, collection_name, title, caption, keywords_json, topic_cluster, score: Number(score) });
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
      return value == null ? null : { async text() { return value; } };
    },
    async put(key, value) { objects.set(key, String(value)); },
    async delete(key) { objects.delete(key); }
  };
}

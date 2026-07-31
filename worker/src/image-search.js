'use strict';

const SEARCH_PATH = '/api/image-search';
const FEEDBACK_PATH = '/api/image-search/feedback';
const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROVIDER_RESULT_LIMIT = 18;
const RESPONSE_RESULT_LIMIT = 30;
const MAX_QUERY_LENGTH = 160;
const MAX_EXCLUSIONS = 120;
let schemaPromise = null;

const TOPIC_RULES = [
  {
    id: 'chemical-structure',
    label: 'Chemical structure',
    querySuffix: 'chemical structure molecule diagram',
    pattern: /chemical|compound|molecule|amino acid|organic compound|zwitterion|metabolite/i
  },
  {
    id: 'medical-neurological',
    label: 'Medical / neurological',
    querySuffix: 'medical neurological neurotransmitter',
    pattern: /neurotransmitter|neurolog|brain|nervous system|clinical|medicine|pharmacolog/i
  },
  {
    id: 'nutrition-metabolism',
    label: 'Nutrition / metabolism',
    querySuffix: 'nutrition metabolism nutrient pathway',
    pattern: /nutrient|nutrition|diet|food|metabolism|metabolic|amino acid|biochemical/i
  },
  {
    id: 'molecular-biology',
    label: 'Molecular biology',
    querySuffix: 'molecular biology protein gene enzyme diagram',
    pattern: /protein|gene|enzyme|receptor|peptide|genetic|molecular biology/i
  },
  {
    id: 'anatomy-clinical',
    label: 'Anatomy / clinical imaging',
    querySuffix: 'anatomy clinical medical image',
    pattern: /anatom|organ|tissue|radiolog|pathology|diagnostic|disease|syndrome/i
  },
  {
    id: 'botany',
    label: 'Plant / botany',
    querySuffix: 'plant botany species photograph',
    pattern: /plant|botany|genus|species|flora|legume|taxonomy/i
  }
];

export async function handleImageSearchRequest(request, env, url = new URL(request.url)) {
  if (url.pathname === FEEDBACK_PATH || url.pathname === `${FEEDBACK_PATH}/`) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return saveFeedback(request, env, url);
  }

  if (url.pathname !== SEARCH_PATH && url.pathname !== `${SEARCH_PATH}/`) return null;
  if (request.method !== 'POST') return methodNotAllowed('POST');
  return searchImages(request, env, url);
}

async function searchImages(request, env, url) {
  assertSameOrigin(request, url);
  const input = await readJson(request);
  const query = normalizeText(input?.query, MAX_QUERY_LENGTH);
  if (!query) return json({ error: 'Enter an image search term.' }, 400);

  await ensureImageFeedbackSchema(env.DB);

  const explicitTopic = normalizeTopic(input?.topic);
  const ambiguity = explicitTopic ? null : await detectWikidataTopics(query);
  if (!explicitTopic && ambiguity?.topics?.length > 1) {
    return json({
      requiresTopic: true,
      query,
      topics: ambiguity.topics.slice(0, 4),
      wikidataEntities: ambiguity.entities
    });
  }

  const topic = explicitTopic || ambiguity?.topics?.[0] || null;
  const topicTag = topic?.label || null;
  const externalQuery = topic?.querySuffix ? `${query} ${topic.querySuffix}` : query;
  const retry = Boolean(input?.retry);
  const excludedUrls = normalizeExclusions(input?.excludeUrls);
  const feedback = await loadFeedback(env.DB, query, topicTag);
  const cacheBucket = env.IMAGE_SEARCH_CACHE || env.LECTURES || null;
  const cacheKey = await buildCacheKey(query, topicTag);

  let cacheHit = false;
  let providerResults = null;
  let sourceStatus = [];

  if (!retry && cacheBucket) {
    const cached = await readCache(cacheBucket, cacheKey);
    if (cached) {
      cacheHit = true;
      providerResults = cached.results;
      sourceStatus = cached.sourceStatus || [];
    }
  }

  if (!providerResults) {
    const fresh = await searchAllSources(externalQuery);
    providerResults = fresh.results;
    sourceStatus = fresh.sourceStatus;
    if (cacheBucket && providerResults.length) {
      await writeCache(cacheBucket, cacheKey, {
        query,
        topic: topicTag,
        externalQuery,
        results: providerResults,
        sourceStatus
      }, cacheTtlSeconds(env));
    }
  }

  const ranked = rankResults(providerResults, feedback, excludedUrls, topic)
    .slice(0, RESPONSE_RESULT_LIMIT);

  return json({
    requiresTopic: false,
    query,
    externalQuery,
    topic: topic ? { id: topic.id, label: topic.label, querySuffix: topic.querySuffix } : null,
    cacheHit,
    retry,
    resultCount: ranked.length,
    results: ranked,
    sourceStatus,
    feedbackApplied: feedback.size > 0
  });
}

async function saveFeedback(request, env, url) {
  assertSameOrigin(request, url);
  await ensureImageFeedbackSchema(env.DB);
  const input = await readJson(request);
  const imageUrl = normalizeUrl(input?.imageUrl);
  const source = normalizeText(input?.source, 40).toLowerCase();
  const queryTerm = normalizeText(input?.queryTerm, MAX_QUERY_LENGTH).toLowerCase();
  const topic = normalizeText(input?.topic, 100) || null;
  const rating = Number(input?.rating);

  if (!imageUrl || !source || !queryTerm || ![1, -1].includes(rating)) {
    return json({ error: 'imageUrl, source, queryTerm and a rating of 1 or -1 are required.' }, 400);
  }

  await env.DB.prepare(`
    INSERT INTO image_feedback (image_url, source, query_term, topic, rating)
    VALUES (?, ?, ?, ?, ?)
  `).bind(imageUrl, source, queryTerm, topic, rating).run();

  return json({ saved: true, imageUrl, rating }, 201);
}

export async function ensureImageFeedbackSchema(db) {
  if (!db) throw new Error('D1 binding “DB” is not configured.');
  if (!schemaPromise) {
    schemaPromise = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS image_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_url TEXT NOT NULL,
        source TEXT NOT NULL,
        query_term TEXT NOT NULL,
        topic TEXT,
        rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS image_feedback_query_topic_idx
        ON image_feedback(query_term COLLATE NOCASE, topic COLLATE NOCASE)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS image_feedback_image_url_idx
        ON image_feedback(image_url)`)
    ]).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function loadFeedback(db, query, topic) {
  const normalizedQuery = query.toLowerCase();
  const statement = topic
    ? db.prepare(`
        SELECT image_url, SUM(rating) AS score
        FROM image_feedback
        WHERE query_term = ? COLLATE NOCASE AND topic = ? COLLATE NOCASE
        GROUP BY image_url
      `).bind(normalizedQuery, topic)
    : db.prepare(`
        SELECT image_url, SUM(rating) AS score
        FROM image_feedback
        WHERE query_term = ? COLLATE NOCASE AND topic IS NULL
        GROUP BY image_url
      `).bind(normalizedQuery);

  const result = await statement.all();
  return new Map((result.results || []).map((row) => [String(row.image_url), Number(row.score || 0)]));
}

async function searchAllSources(query) {
  const providers = [
    ['wikimedia', () => searchWikimedia(query)],
    ['openverse', () => searchOpenverse(query)],
    ['nlm-open-i', () => searchOpenI(query)]
  ];
  const settled = await Promise.allSettled(providers.map(([, run]) => run()));
  const results = [];
  const sourceStatus = [];

  settled.forEach((outcome, index) => {
    const source = providers[index][0];
    if (outcome.status === 'fulfilled') {
      sourceStatus.push({ source, ok: true, count: outcome.value.length });
      results.push(...outcome.value);
    } else {
      sourceStatus.push({
        source,
        ok: false,
        count: 0,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      });
    }
  });

  return { results: dedupeResults(results), sourceStatus };
}

async function searchWikimedia(query) {
  const endpoint = new URL('https://commons.wikimedia.org/w/api.php');
  endpoint.searchParams.set('action', 'query');
  endpoint.searchParams.set('generator', 'search');
  endpoint.searchParams.set('gsrsearch', query);
  endpoint.searchParams.set('gsrnamespace', '6');
  endpoint.searchParams.set('gsrlimit', String(PROVIDER_RESULT_LIMIT));
  endpoint.searchParams.set('prop', 'imageinfo');
  endpoint.searchParams.set('iiprop', 'url|mime|extmetadata|size');
  endpoint.searchParams.set('iiurlwidth', '960');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('formatversion', '2');
  endpoint.searchParams.set('origin', '*');

  const payload = await fetchJson(endpoint);
  const pages = payload?.query?.pages || [];
  return pages.flatMap((page) => {
    const info = page?.imageinfo?.[0];
    if (!info || !String(info.mime || '').startsWith('image/')) return [];
    const imageUrl = normalizeUrl(info.thumburl || info.url);
    if (!imageUrl) return [];
    const metadata = info.extmetadata || {};
    return [{
      id: `wikimedia:${page.pageid || page.title}`,
      source: 'wikimedia',
      sourceLabel: 'Wikimedia Commons',
      imageUrl,
      originalUrl: normalizeUrl(info.url) || imageUrl,
      sourceUrl: normalizeUrl(info.descriptionurl) || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || '')}`,
      title: stripFilePrefix(page.title) || stripHtml(metadata.ObjectName?.value) || query,
      caption: stripHtml(metadata.ImageDescription?.value || metadata.ObjectName?.value || ''),
      creator: stripHtml(metadata.Artist?.value || metadata.Credit?.value || ''),
      license: stripHtml(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || ''),
      licenseUrl: normalizeUrl(metadata.LicenseUrl?.value),
      width: Number(info.thumbwidth || info.width || 0) || null,
      height: Number(info.thumbheight || info.height || 0) || null
    }];
  });
}

async function searchOpenverse(query) {
  const endpoint = new URL('https://api.openverse.org/v1/images/');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('page_size', String(PROVIDER_RESULT_LIMIT));
  endpoint.searchParams.set('mature', 'false');

  const payload = await fetchJson(endpoint);
  return (payload?.results || []).flatMap((item) => {
    const imageUrl = normalizeUrl(item.thumbnail || item.url);
    if (!imageUrl) return [];
    return [{
      id: `openverse:${item.id || imageUrl}`,
      source: 'openverse',
      sourceLabel: 'Openverse',
      imageUrl,
      originalUrl: normalizeUrl(item.url) || imageUrl,
      sourceUrl: normalizeUrl(item.foreign_landing_url || item.detail_url) || imageUrl,
      title: normalizeText(item.title, 240) || query,
      caption: normalizeText(item.description, 600),
      creator: normalizeText(item.creator, 200),
      license: normalizeText(item.license, 80),
      licenseUrl: normalizeUrl(item.license_url),
      width: Number(item.width || 0) || null,
      height: Number(item.height || 0) || null
    }];
  });
}

async function searchOpenI(query) {
  const endpoint = new URL('https://openi.nlm.nih.gov/api/search');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('m', '1');
  endpoint.searchParams.set('n', String(PROVIDER_RESULT_LIMIT));

  const payload = await fetchJson(endpoint);
  const items = payload?.list || payload?.results || payload?.images || [];
  return items.flatMap((item, index) => {
    const id = normalizeText(item.imgId || item.imageId || item.id, 180) || `${index}`;
    const imageUrl = absoluteUrl(item.imgUrl || item.imageUrl || item.image_url || item.thumbnail || item.thumb, 'https://openi.nlm.nih.gov');
    if (!imageUrl) return [];
    const sourceUrl = normalizeUrl(item.detailUrl || item.sourceUrl)
      || `https://openi.nlm.nih.gov/detailedresult?img=${encodeURIComponent(id)}&req=4`;
    return [{
      id: `nlm-open-i:${id}`,
      source: 'nlm-open-i',
      sourceLabel: 'NLM Open-i',
      imageUrl,
      originalUrl: imageUrl,
      sourceUrl,
      title: normalizeText(item.title || item.articleTitle || item.article_title, 240) || query,
      caption: normalizeText(item.caption || item.description || item.abstract, 800),
      creator: normalizeText(item.author || item.authors || item.journal, 240),
      license: normalizeText(item.license || item.licenseType, 120) || 'Check source record',
      licenseUrl: normalizeUrl(item.licenseUrl || item.license_url),
      width: Number(item.width || 0) || null,
      height: Number(item.height || 0) || null
    }];
  });
}

async function detectWikidataTopics(query) {
  try {
    const searchEndpoint = new URL('https://www.wikidata.org/w/api.php');
    searchEndpoint.searchParams.set('action', 'wbsearchentities');
    searchEndpoint.searchParams.set('search', query);
    searchEndpoint.searchParams.set('language', 'en');
    searchEndpoint.searchParams.set('uselang', 'en');
    searchEndpoint.searchParams.set('type', 'item');
    searchEndpoint.searchParams.set('limit', '6');
    searchEndpoint.searchParams.set('format', 'json');
    searchEndpoint.searchParams.set('origin', '*');

    const searchPayload = await fetchJson(searchEndpoint);
    const searchRows = (searchPayload?.search || []).slice(0, 6);
    const entityIds = searchRows.map((row) => row.id).filter(Boolean);
    if (!entityIds.length) return { topics: [], entities: [] };

    const entitiesPayload = await getWikidataEntities(entityIds, 'claims|labels|descriptions');
    const entities = entityIds.map((id) => entitiesPayload?.entities?.[id]).filter(Boolean);
    const instanceIds = new Set();
    entities.forEach((entity) => {
      (entity?.claims?.P31 || []).forEach((claim) => {
        const id = claim?.mainsnak?.datavalue?.value?.id;
        if (id) instanceIds.add(id);
      });
    });

    const instancesPayload = instanceIds.size
      ? await getWikidataEntities([...instanceIds], 'labels|descriptions')
      : { entities: {} };
    const instanceLabels = new Map(Object.entries(instancesPayload?.entities || {}).map(([id, entity]) => [
      id,
      entity?.labels?.en?.value || entity?.descriptions?.en?.value || id
    ]));

    const entitySummaries = entities.map((entity) => {
      const instances = (entity?.claims?.P31 || []).map((claim) => {
        const id = claim?.mainsnak?.datavalue?.value?.id;
        return id ? instanceLabels.get(id) || id : '';
      }).filter(Boolean);
      return {
        id: entity.id,
        label: entity?.labels?.en?.value || entity.id,
        description: entity?.descriptions?.en?.value || '',
        instances
      };
    });

    const corpus = entitySummaries.flatMap((entity) => [entity.label, entity.description, ...entity.instances]);
    const topics = TOPIC_RULES.map((rule) => {
      const score = corpus.reduce((total, value) => total + (rule.pattern.test(String(value)) ? 1 : 0), 0);
      return score ? { id: rule.id, label: rule.label, querySuffix: rule.querySuffix, score } : null;
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 4)
      .map(({ score, ...topic }) => topic);

    return { topics, entities: entitySummaries };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'wikidata_ambiguity_failed',
      message: error instanceof Error ? error.message : String(error)
    }));
    return { topics: [], entities: [] };
  }
}

async function getWikidataEntities(ids, props) {
  const endpoint = new URL('https://www.wikidata.org/w/api.php');
  endpoint.searchParams.set('action', 'wbgetentities');
  endpoint.searchParams.set('ids', ids.join('|'));
  endpoint.searchParams.set('props', props);
  endpoint.searchParams.set('languages', 'en');
  endpoint.searchParams.set('languagefallback', '1');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('origin', '*');
  return fetchJson(endpoint);
}

function rankResults(results, feedback, excludedUrls, topic) {
  return results.flatMap((result, providerIndex) => {
    const imageUrl = normalizeUrl(result.imageUrl);
    if (!imageUrl || excludedUrls.has(imageUrl)) return [];
    const feedbackScore = Number(feedback.get(imageUrl) || 0);
    if (feedbackScore < 0) return [];
    return [{
      ...result,
      imageUrl,
      topic: topic?.label || null,
      topicId: topic?.id || null,
      feedbackScore,
      rankScore: feedbackScore * 1000 - providerIndex
    }];
  }).sort((a, b) => b.rankScore - a.rankScore || a.sourceLabel.localeCompare(b.sourceLabel))
    .map(({ rankScore, ...result }) => result);
}

function dedupeResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    const key = normalizeUrl(result.originalUrl) || normalizeUrl(result.imageUrl) || result.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

async function fetchJson(input, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const response = await fetch(input, {
      headers: {
        Accept: 'application/json',
        'Api-User-Agent': 'LectureStudioImageSearch/1.0 (educational image discovery)'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${new URL(String(input)).hostname} returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function buildCacheKey(query, topic) {
  const bytes = new TextEncoder().encode(`${query.toLowerCase()}\n${String(topic || '').toLowerCase()}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `image-search-cache/v1/${hash}.json`;
}

async function readCache(bucket, key) {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    const payload = JSON.parse(await object.text());
    if (!payload?.expiresAt || payload.expiresAt <= Date.now() || !Array.isArray(payload.results)) {
      await bucket.delete(key).catch(() => {});
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function writeCache(bucket, key, payload, ttlSeconds) {
  const cachedAt = Date.now();
  const expiresAt = cachedAt + ttlSeconds * 1000;
  await bucket.put(key, JSON.stringify({ ...payload, cachedAt, expiresAt }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { expiresAt: String(expiresAt), kind: 'image-search-metadata' }
  });
}

function cacheTtlSeconds(env) {
  const configured = Number(env.IMAGE_SEARCH_CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.max(300, Math.min(configured, 30 * 24 * 60 * 60));
}

function normalizeTopic(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const matched = TOPIC_RULES.find((topic) => topic.id === value || topic.label.toLowerCase() === value.toLowerCase());
    return matched ? { id: matched.id, label: matched.label, querySuffix: matched.querySuffix } : null;
  }
  const id = normalizeText(value.id, 80);
  const label = normalizeText(value.label, 100);
  const querySuffix = normalizeText(value.querySuffix, 140);
  if (!id || !label || !querySuffix) return null;
  return { id, label, querySuffix };
}

function normalizeExclusions(value) {
  const urls = Array.isArray(value) ? value : [];
  return new Set(urls.slice(0, MAX_EXCLUSIONS).map(normalizeUrl).filter(Boolean));
}

function normalizeText(value, maxLength = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function absoluteUrl(value, base) {
  try {
    const url = new URL(String(value || ''), base);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function stripHtml(value) {
  return normalizeText(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"), 800);
}

function stripFilePrefix(value) {
  return normalizeText(value, 240).replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '');
}

function assertSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin image-search requests are not allowed.');
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) throw new HttpError(415, 'The request body must be JSON.');
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'The JSON request body is invalid.');
  }
}

function methodNotAllowed(allow) {
  return json({ error: `Method not allowed. Use ${allow}.` }, 405, { Allow: allow });
}

function json(payload, status = 200, extraHeaders = {}) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function imageSearchErrorResponse(error) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  console.error(JSON.stringify({
    event: 'adaptive_image_search_error',
    message: error instanceof Error ? error.message : String(error)
  }));
  return json({ error: 'The adaptive image search could not complete.' }, 500);
}

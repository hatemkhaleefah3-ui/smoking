'use strict';

import {
  handleImageSearchRequest as handleCoreImageSearchRequest,
  ensureImageFeedbackSchema,
  imageSearchErrorResponse,
  rankResults
} from './image-search-core.js';

const SEARCH_PATH = '/api/image-search';
const FEEDBACK_PATH = '/api/image-search/feedback';
const PROVIDER_RESULT_LIMIT = 18;
const RESPONSE_RESULT_LIMIT = 30;
const MAX_QUERY_LENGTH = 160;
const MAX_EXCLUSIONS = 120;
const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEBUG_BODY_LIMIT = 50_000;
const CACHE_VERSION = 'v2';
const USER_AGENT = 'LectureStudioImageSearch/1.2 (https://smoking-e1j.pages.dev; educational image discovery)';

const TOPIC_RULES = [
  { id: 'chemical-structure', label: 'Chemical structure', querySuffix: 'chemical structure molecule diagram', pattern: /chemical|compound|molecule|amino acid|organic compound|zwitterion|metabolite/i },
  { id: 'medical-neurological', label: 'Medical / neurological', querySuffix: 'medical neurological neurotransmitter', pattern: /neurotransmitter|neurolog|brain|nervous system|clinical|medicine|pharmacolog|receptor/i },
  { id: 'nutrition-metabolism', label: 'Nutrition / metabolism', querySuffix: 'nutrition metabolism nutrient pathway', pattern: /nutrient|nutrition|diet|food|metabolism|metabolic|amino acid|biochemical/i },
  { id: 'molecular-biology', label: 'Molecular biology', querySuffix: 'molecular biology protein gene enzyme diagram', pattern: /protein|gene|enzyme|receptor|peptide|genetic|molecular biology/i },
  { id: 'anatomy-clinical', label: 'Anatomy / clinical imaging', querySuffix: 'anatomy clinical medical image', pattern: /anatom|organ|tissue|radiolog|pathology|diagnostic|disease|syndrome/i },
  { id: 'botany', label: 'Plant / botany', querySuffix: 'plant botany species photograph', pattern: /plant|botany|genus|species|flora|legume|taxonomy|soybean/i }
];

export async function handleImageSearchRequest(request, env, url = new URL(request.url)) {
  if (url.pathname === FEEDBACK_PATH || url.pathname === `${FEEDBACK_PATH}/`) {
    return handleCoreImageSearchRequest(request, env, url);
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
  const debug = Boolean(input?.debug);
  const diagnostics = createDiagnostics(debug);
  const explicitTopic = normalizeTopic(input?.topic);
  const ambiguity = explicitTopic ? null : await detectWikidataTopics(query, diagnostics);
  const requiresTopic = !explicitTopic && Boolean(ambiguity?.topics?.length > 1);

  console.log(JSON.stringify({
    event: 'wikidata_topic_decision',
    query,
    requiresTopic,
    topicCount: ambiguity?.topics?.length || 0,
    topics: ambiguity?.topics?.map((topic) => topic.id) || []
  }));

  if (requiresTopic) {
    return json({
      requiresTopic: true,
      query,
      topics: ambiguity.topics.slice(0, 4),
      wikidataEntities: ambiguity.entities,
      ...(debug ? { debugDiagnostics: diagnostics } : {})
    });
  }

  const topic = explicitTopic || ambiguity?.topics?.[0] || null;
  const topicTag = topic?.label || null;
  const externalQuery = topic?.querySuffix ? `${query} ${topic.querySuffix}` : query;
  const retry = Boolean(input?.retry || debug);
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
    const fresh = await searchAllSources(externalQuery, diagnostics);
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
    feedbackApplied: feedback.size > 0,
    feedbackRanking: {
      method: 'net-score',
      negativeRemovalThreshold: -3
    },
    ...(debug ? { debugDiagnostics: diagnostics } : {})
  });
}

async function searchAllSources(query, diagnostics) {
  const providers = [
    ['wikimedia', () => searchWikimedia(query, diagnostics)],
    ['openverse', () => searchOpenverse(query, diagnostics)],
    ['nlm-open-i', () => searchOpenI(query, diagnostics)]
  ];
  const settled = await Promise.allSettled(providers.map(([, run]) => run()));
  const results = [];
  const sourceStatus = [];

  settled.forEach((outcome, index) => {
    const source = providers[index][0];
    const requestDiagnostic = latestDiagnostic(diagnostics.providers, source);
    if (outcome.status === 'fulfilled') {
      sourceStatus.push({
        source,
        ok: true,
        count: outcome.value.length,
        requestUrl: requestDiagnostic?.requestUrl || null,
        status: requestDiagnostic?.status ?? null,
        responseType: requestDiagnostic?.contentType || null
      });
      results.push(...outcome.value);
    } else {
      sourceStatus.push({
        source,
        ok: false,
        count: 0,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        requestUrl: requestDiagnostic?.requestUrl || null,
        status: requestDiagnostic?.status ?? null,
        responseType: requestDiagnostic?.contentType || null
      });
    }
  });

  return { results: dedupeResults(results), sourceStatus };
}

async function searchWikimedia(query, diagnostics) {
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

  const payload = await fetchJson(endpoint, {
    source: 'wikimedia',
    stage: 'image-search',
    diagnostics: diagnostics.providers
  });
  const rawPages = payload?.query?.pages;
  const pages = Array.isArray(rawPages) ? rawPages : Object.values(rawPages || {});
  const results = pages.flatMap((page) => {
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
  logZeroResults('wikimedia', endpoint, results, payload);
  return results;
}

async function searchOpenverse(query, diagnostics) {
  const endpoint = new URL('https://api.openverse.org/v1/images/');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('page_size', String(PROVIDER_RESULT_LIMIT));
  endpoint.searchParams.set('mature', 'false');

  const payload = await fetchJson(endpoint, {
    source: 'openverse',
    stage: 'image-search',
    diagnostics: diagnostics.providers
  });
  const results = (payload?.results || []).flatMap((item) => {
    const primaryUrl = normalizeHttpsUrl(item.url);
    const thumbnailUrl = normalizeHttpsUrl(item.thumbnail);
    if (!primaryUrl) return [];
    return [{
      id: `openverse:${item.id || primaryUrl}`,
      source: 'openverse',
      sourceLabel: 'Openverse',
      imageUrl: primaryUrl,
      originalUrl: primaryUrl,
      thumbnailUrl: thumbnailUrl && thumbnailUrl !== primaryUrl ? thumbnailUrl : null,
      sourceUrl: normalizeUrl(item.foreign_landing_url || item.detail_url) || primaryUrl,
      title: normalizeText(item.title, 240) || query,
      caption: normalizeText(item.description, 600),
      creator: normalizeText(item.creator, 200),
      license: normalizeText(item.license, 80),
      licenseUrl: normalizeUrl(item.license_url),
      width: Number(item.width || 0) || null,
      height: Number(item.height || 0) || null
    }];
  });
  logZeroResults('openverse', endpoint, results, payload);
  return results;
}

async function searchOpenI(query, diagnostics) {
  const endpoint = new URL('https://openi.nlm.nih.gov/api/search');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('m', '1');
  endpoint.searchParams.set('n', String(PROVIDER_RESULT_LIMIT));

  const payload = await fetchJson(endpoint, {
    source: 'nlm-open-i',
    stage: 'image-search',
    diagnostics: diagnostics.providers
  });
  const items = normalizeOpenIItems(payload);
  const results = items.flatMap((item, index) => {
    const imagePath = normalizeText(
      item.imgLarge || item.imgThumbLarge || item.imgGrid150 || item.imgThumb ||
      item.imgUrl || item.imageUrl || item.image_url || item.thumbnail || item.thumb,
      1200
    );
    if (!imagePath) return [];
    const imageUrl = absoluteUrl(imagePath, 'https://openi.nlm.nih.gov');
    if (!imageUrl || imageUrl === 'https://openi.nlm.nih.gov/') return [];

    const figureId = normalizeText(item.image?.id, 120);
    const recordId = normalizeText(item.uid || item.pmcid || item.imgId || item.imageId || item.id, 180);
    const id = [recordId, figureId].filter(Boolean).join(':') || String(index);
    const detailedPath = normalizeText(item.detailedQueryURL || item.detailUrl || item.sourceUrl, 1200);
    const sourceUrl = detailedPath
      ? absoluteUrl(detailedPath, 'https://openi.nlm.nih.gov')
      : `https://openi.nlm.nih.gov/detailedresult?img=${encodeURIComponent(id)}&req=4`;

    return [{
      id: `nlm-open-i:${id}`,
      source: 'nlm-open-i',
      sourceLabel: 'NLM Open-i',
      imageUrl,
      originalUrl: imageUrl,
      sourceUrl,
      title: normalizeText(item.title || item.articleTitle || item.article_title, 240) || query,
      caption: stripHtml(item.image?.caption || item.caption || item.description || item.abstract || ''),
      creator: normalizeText(item.authors || item.author || item.journal_title || item.journal || item.journal_abbr, 240),
      license: normalizeText(item.license || item.licenseType, 120) || 'Check source record',
      licenseUrl: normalizeUrl(item.licenseUrl || item.license_url),
      width: Number(item.width || 0) || null,
      height: Number(item.height || 0) || null
    }];
  });
  logZeroResults('nlm-open-i', endpoint, results, payload);
  return results;
}

function normalizeOpenIItems(payload) {
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.images)) return payload.images;
  if (Array.isArray(payload?.list?.results)) return payload.list.results;
  if (Array.isArray(payload?.response?.docs)) return payload.response.docs;
  return [];
}

async function detectWikidataTopics(query, diagnostics) {
  try {
    const searchEndpoint = new URL('https://www.wikidata.org/w/api.php');
    searchEndpoint.searchParams.set('action', 'wbsearchentities');
    searchEndpoint.searchParams.set('search', query);
    searchEndpoint.searchParams.set('language', 'en');
    searchEndpoint.searchParams.set('uselang', 'en');
    searchEndpoint.searchParams.set('type', 'item');
    searchEndpoint.searchParams.set('limit', '8');
    searchEndpoint.searchParams.set('format', 'json');
    searchEndpoint.searchParams.set('origin', '*');

    const searchPayload = await fetchJson(searchEndpoint, {
      source: 'wikidata',
      stage: 'wbsearchentities',
      diagnostics: diagnostics.wikidata
    });
    const searchRows = (searchPayload?.search || []).slice(0, 8);
    const entityIds = searchRows.map((row) => row.id).filter(Boolean);
    if (!entityIds.length) return { topics: [], entities: [] };

    const entitiesPayload = await getWikidataEntities(
      entityIds,
      'claims|labels|descriptions',
      diagnostics,
      'wbgetentities-entities'
    );
    const entities = entityIds.map((id) => entitiesPayload?.entities?.[id]).filter(Boolean);
    const instanceIds = new Set();
    entities.forEach((entity) => {
      (entity?.claims?.P31 || []).forEach((claim) => {
        const id = claim?.mainsnak?.datavalue?.value?.id;
        if (id) instanceIds.add(id);
      });
    });

    const instancesPayload = instanceIds.size
      ? await getWikidataEntities(
          [...instanceIds],
          'labels|descriptions',
          diagnostics,
          'wbgetentities-instances'
        )
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

    const corpus = [
      ...searchRows.flatMap((row) => [row.label, row.description, row.match?.text]),
      ...entitySummaries.flatMap((entity) => [entity.label, entity.description, ...entity.instances])
    ];
    const topics = TOPIC_RULES.map((rule) => {
      const score = corpus.reduce((total, value) =>
        total + (rule.pattern.test(String(value || '')) ? 1 : 0), 0);
      return score ? { id: rule.id, label: rule.label, querySuffix: rule.querySuffix, score } : null;
    }).filter(Boolean)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
      .slice(0, 4)
      .map(({ score, ...topic }) => topic);

    return { topics, entities: entitySummaries };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'wikidata_ambiguity_failed',
      query,
      message: error instanceof Error ? error.message : String(error)
    }));
    return { topics: [], entities: [] };
  }
}

async function getWikidataEntities(ids, props, diagnostics, stage) {
  const endpoint = new URL('https://www.wikidata.org/w/api.php');
  endpoint.searchParams.set('action', 'wbgetentities');
  endpoint.searchParams.set('ids', ids.join('|'));
  endpoint.searchParams.set('props', props);
  endpoint.searchParams.set('languages', 'en');
  endpoint.searchParams.set('languagefallback', '1');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('origin', '*');
  return fetchJson(endpoint, {
    source: 'wikidata',
    stage,
    diagnostics: diagnostics.wikidata
  });
}

async function fetchJson(input, { source, stage, diagnostics }, timeoutMs = 12_000) {
  const requestUrl = String(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  let response;
  let rawBody = '';
  try {
    response = await fetch(input, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Api-User-Agent': USER_AGENT
      },
      signal: controller.signal
    });
    rawBody = await response.text();
    const entry = {
      source,
      stage,
      requestUrl,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('Content-Type') || '',
      rawResponseBody: diagnostics.enabled ? limitBody(rawBody) : undefined
    };
    diagnostics.push(entry);

    if (!response.ok) {
      logFetchFailure({ ...entry, rawResponseBody: rawBody, reason: 'http-status' });
      throw new ExternalFetchError(`${source} returned HTTP ${response.status}`);
    }

    try {
      return JSON.parse(rawBody);
    } catch (error) {
      logFetchFailure({
        ...entry,
        rawResponseBody: rawBody,
        reason: 'invalid-json',
        parseError: error instanceof Error ? error.message : String(error)
      });
      throw new ExternalFetchError(`${source} returned a non-JSON response`);
    }
  } catch (error) {
    if (error instanceof ExternalFetchError) throw error;
    const entry = {
      source,
      stage,
      requestUrl,
      status: response?.status ?? null,
      ok: false,
      contentType: response?.headers?.get('Content-Type') || '',
      rawResponseBody: diagnostics.enabled ? limitBody(rawBody) : undefined,
      networkError: error instanceof Error ? error.message : String(error)
    };
    diagnostics.push(entry);
    logFetchFailure({ ...entry, rawResponseBody: rawBody, reason: 'network-error' });
    throw new ExternalFetchError(`${source} request failed: ${entry.networkError}`);
  } finally {
    clearTimeout(timeout);
  }
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

function dedupeResults(results) {
  const seen = new Set();
  const output = [];
  for (const result of results) {
    const key = normalizeUrl(result.originalUrl) || normalizeUrl(result.imageUrl) || result.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

function createDiagnostics(enabled) {
  const providers = [];
  providers.enabled = enabled;
  const wikidata = [];
  wikidata.enabled = enabled;
  return { enabled, providers, wikidata };
}

function latestDiagnostic(items, source) {
  return [...items].reverse().find((item) => item.source === source) || null;
}

function logFetchFailure(details) {
  console.error(JSON.stringify({
    event: 'external_image_provider_fetch_failed',
    ...details
  }));
}

function logZeroResults(source, endpoint, results, payload) {
  if (results.length) return;
  console.warn(JSON.stringify({
    event: 'external_image_provider_zero_results',
    source,
    requestUrl: String(endpoint),
    responseKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
    providerReportedCount: Number(payload?.result_count || payload?.total || payload?.count || 0)
  }));
}

function limitBody(value) {
  const text = String(value || '');
  return text.length <= DEBUG_BODY_LIMIT
    ? text
    : `${text.slice(0, DEBUG_BODY_LIMIT)}\n...[truncated ${text.length - DEBUG_BODY_LIMIT} characters]`;
}

async function buildCacheKey(query, topic) {
  const bytes = new TextEncoder().encode(`${CACHE_VERSION}\n${query.toLowerCase()}\n${String(topic || '').toLowerCase()}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `image-search-cache/${CACHE_VERSION}/${hash}.json`;
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
    const matched = TOPIC_RULES.find((topic) =>
      topic.id === value || topic.label.toLowerCase() === value.toLowerCase());
    return matched ? { id: matched.id, label: matched.label, querySuffix: matched.querySuffix } : null;
  }
  const id = normalizeText(value.id, 80);
  const label = normalizeText(value.label, 100);
  const querySuffix = normalizeText(value.querySuffix, 140);
  return id && label && querySuffix ? { id, label, querySuffix } : null;
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
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeHttpsUrl(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function absoluteUrl(value, base) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
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
  if (origin && origin !== url.origin) {
    throw new HttpError(403, 'Cross-origin image-search requests are not allowed.');
  }
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'The request body must be JSON.');
  }
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

class ExternalFetchError extends Error {}

export { ensureImageFeedbackSchema, imageSearchErrorResponse, rankResults };

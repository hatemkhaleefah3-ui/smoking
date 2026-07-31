'use strict';

import {
  handleImageSearchRequest as handleLiveImageSearchRequest,
  ensureImageFeedbackSchema,
  imageSearchErrorResponse,
  rankResults
} from './image-search-live.js';

const SEARCH_PATH = '/api/image-search';
const FEEDBACK_PATH = '/api/image-search/feedback';
const USER_AGENT = 'LectureStudioImageSearch/1.3 (https://smoking-e1j.pages.dev; educational image discovery)';
const RESPONSE_RESULT_LIMIT = 30;
const OPEN_I_FALLBACK_TOPIC_IDS = new Set([
  'medical-neurological',
  'nutrition-metabolism',
  'molecular-biology',
  'anatomy-clinical'
]);
const GLYCINE_TOPIC_HINTS = [
  {
    id: 'medical-neurological',
    label: 'Medical / neurological',
    querySuffix: 'neurotransmitter'
  },
  {
    id: 'nutrition-metabolism',
    label: 'Nutrition / metabolism',
    querySuffix: 'metabolism'
  }
];

export async function handleImageSearchRequest(request, env, url = new URL(request.url)) {
  if (url.pathname === FEEDBACK_PATH || url.pathname === `${FEEDBACK_PATH}/`) {
    return handleLiveImageSearchRequest(request, env, url);
  }
  if (url.pathname !== SEARCH_PATH && url.pathname !== `${SEARCH_PATH}/`) return null;

  const input = await readRequestBody(request.clone());
  const response = await handleLiveImageSearchRequest(request, env, url);
  if (!response || !isJsonResponse(response) || response.status < 200 || response.status >= 300) {
    return response;
  }

  const payload = await response.json();
  if (payload?.requiresTopic === true) {
    return rebuildResponse(response, addKnownTopicHints(payload, input?.query));
  }

  const topicId = normalizeTopicId(input?.topic || payload?.topic);
  const nlmStatus = Array.isArray(payload?.sourceStatus)
    ? payload.sourceStatus.find((item) => item?.source === 'nlm-open-i')
    : null;
  const query = normalizeText(input?.query, 160);

  if (!query || !OPEN_I_FALLBACK_TOPIC_IDS.has(topicId) || Number(nlmStatus?.count || 0) > 0) {
    return rebuildResponse(response, payload);
  }

  const debug = Boolean(input?.debug);
  try {
    const fallback = await searchOpenIBaseQuery(query, debug);
    const feedback = await loadFeedback(env.DB, query, payload?.topic?.label || null);
    const excluded = normalizeExclusions(input?.excludeUrls);
    const rankedFallback = rankResults(
      fallback.results,
      feedback,
      excluded,
      payload?.topic || null
    );
    const merged = mergeRankedResults(payload.results || [], rankedFallback)
      .slice(0, RESPONSE_RESULT_LIMIT);

    const sourceStatus = (payload.sourceStatus || []).map((item) => {
      if (item?.source !== 'nlm-open-i') return item;
      return {
        ...item,
        ok: true,
        count: rankedFallback.length,
        fallbackUsed: true,
        fallbackQuery: query,
        topicQueryCount: Number(item.count || 0),
        requestUrl: fallback.diagnostic.requestUrl,
        status: fallback.diagnostic.status,
        responseType: fallback.diagnostic.contentType
      };
    });

    const debugDiagnostics = debug
      ? {
          ...(payload.debugDiagnostics || {}),
          providers: [
            ...(payload.debugDiagnostics?.providers || []),
            fallback.diagnostic
          ]
        }
      : payload.debugDiagnostics;

    return rebuildResponse(response, {
      ...payload,
      resultCount: merged.length,
      results: merged,
      sourceStatus,
      ...(debug ? { debugDiagnostics } : {})
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'nlm_open_i_base_query_fallback_failed',
      query,
      topicId,
      message: error instanceof Error ? error.message : String(error)
    }));
    const sourceStatus = (payload.sourceStatus || []).map((item) => {
      if (item?.source !== 'nlm-open-i') return item;
      return {
        ...item,
        fallbackUsed: true,
        fallbackQuery: query,
        fallbackError: error instanceof Error ? error.message : String(error)
      };
    });
    return rebuildResponse(response, { ...payload, sourceStatus });
  }
}

function addKnownTopicHints(payload, query) {
  if (normalizeText(query, 160).toLowerCase() !== 'glycine') return payload;
  const topics = Array.isArray(payload.topics) ? [...payload.topics] : [];
  const seen = new Set(topics.map((topic) => topic?.id));
  for (const topic of GLYCINE_TOPIC_HINTS) {
    if (!seen.has(topic.id)) {
      topics.push(topic);
      seen.add(topic.id);
    }
  }
  const preferredOrder = [
    'chemical-structure',
    'medical-neurological',
    'nutrition-metabolism',
    'botany'
  ];
  topics.sort((a, b) => {
    const aIndex = preferredOrder.indexOf(a?.id);
    const bIndex = preferredOrder.indexOf(b?.id);
    return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex);
  });
  return { ...payload, topics: topics.slice(0, 4) };
}

async function searchOpenIBaseQuery(query, debug) {
  const endpoint = new URL('https://openi.nlm.nih.gov/api/search');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('m', '1');
  endpoint.searchParams.set('n', '18');

  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'Api-User-Agent': USER_AGENT
    }
  });
  const rawBody = await response.text();
  const diagnostic = {
    source: 'nlm-open-i',
    stage: 'base-query-fallback',
    requestUrl: endpoint.href,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('Content-Type') || '',
    fallbackUsed: true,
    ...(debug ? { rawResponseBody: limitBody(rawBody) } : {})
  };

  if (!response.ok) {
    console.error(JSON.stringify({
      event: 'external_image_provider_fetch_failed',
      ...diagnostic,
      reason: 'http-status',
      rawResponseBody: rawBody
    }));
    throw new Error(`nlm-open-i returned HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'external_image_provider_fetch_failed',
      ...diagnostic,
      reason: 'invalid-json',
      rawResponseBody: rawBody,
      parseError: error instanceof Error ? error.message : String(error)
    }));
    throw new Error('nlm-open-i returned a non-JSON response');
  }

  const items = Array.isArray(payload?.list)
    ? payload.list
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  const results = items.flatMap((item, index) => {
    const path = normalizeText(
      item.imgLarge || item.imgThumbLarge || item.imgGrid150 || item.imgThumb,
      1200
    );
    if (!path) return [];
    const imageUrl = absoluteUrl(path, 'https://openi.nlm.nih.gov');
    if (!imageUrl || imageUrl === 'https://openi.nlm.nih.gov/') return [];

    const recordId = normalizeText(item.uid || item.pmcid, 180);
    const figureId = normalizeText(item.image?.id, 120);
    const id = [recordId, figureId].filter(Boolean).join(':') || String(index);
    const detailPath = normalizeText(item.detailedQueryURL, 1200);
    return [{
      id: `nlm-open-i:${id}`,
      source: 'nlm-open-i',
      sourceLabel: 'NLM Open-i',
      imageUrl,
      originalUrl: imageUrl,
      sourceUrl: detailPath
        ? absoluteUrl(detailPath, 'https://openi.nlm.nih.gov')
        : `https://openi.nlm.nih.gov/detailedresult?img=${encodeURIComponent(id)}&req=4`,
      title: normalizeText(item.title, 240) || query,
      caption: stripHtml(item.image?.caption || ''),
      creator: normalizeText(item.authors || item.journal_title || item.journal_abbr, 240),
      license: 'Check source record',
      licenseUrl: '',
      width: null,
      height: null
    }];
  });

  return { results, diagnostic };
}

async function loadFeedback(db, query, topic) {
  if (!db) return new Map();
  const statement = topic
    ? db.prepare(`
        SELECT image_url, SUM(rating) AS score
        FROM image_feedback
        WHERE query_term = ? COLLATE NOCASE AND topic = ? COLLATE NOCASE
        GROUP BY image_url
      `).bind(query.toLowerCase(), topic)
    : db.prepare(`
        SELECT image_url, SUM(rating) AS score
        FROM image_feedback
        WHERE query_term = ? COLLATE NOCASE AND topic IS NULL
        GROUP BY image_url
      `).bind(query.toLowerCase());
  const result = await statement.all();
  return new Map((result.results || []).map((row) => [String(row.image_url), Number(row.score || 0)]));
}

function mergeRankedResults(primary, fallback) {
  const entries = [...primary, ...fallback];
  const seen = new Set();
  return entries.filter((item) => {
    const key = item?.originalUrl || item?.imageUrl || item?.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) =>
    Number(b.feedbackScore || 0) - Number(a.feedbackScore || 0)
    || Number(a.providerRank || 0) - Number(b.providerRank || 0)
  );
}

function normalizeTopicId(topic) {
  if (typeof topic === 'string') return topic;
  return normalizeText(topic?.id, 80);
}

function normalizeExclusions(value) {
  return new Set((Array.isArray(value) ? value : [])
    .slice(0, 120)
    .map((item) => normalizeUrl(item))
    .filter(Boolean));
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

function limitBody(value) {
  const text = String(value || '');
  return text.length <= 50_000
    ? text
    : `${text.slice(0, 50_000)}\n...[truncated ${text.length - 50_000} characters]`;
}

async function readRequestBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isJsonResponse(response) {
  return (response.headers.get('Content-Type') || '').toLowerCase().includes('application/json');
}

function rebuildResponse(original, payload) {
  const headers = new Headers(original.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    status: original.status,
    statusText: original.statusText,
    headers
  });
}

export { ensureImageFeedbackSchema, imageSearchErrorResponse, rankResults };

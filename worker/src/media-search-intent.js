import { handleEnhancedMediaSearch } from './media-search-enhanced.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const TARGET_USEFUL_IMAGES = 3;
const MAX_ROUNDS = 4;
const QUERIES_PER_ROUND = 3;
const MAX_SEARCH_QUERIES = 12;
const MAX_CANDIDATES = 30;
const MAX_RESPONSE_IMAGES = 18;
const USEFUL_SCORE = 60;
const REQUEST_TIMEOUT_MS = 12_000;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherIntentSearch/1.0 (https://github.com/hatemkhaleefah3-ui/smoking)';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with',
  'diagram', 'image', 'illustration', 'photo', 'photograph', 'picture', 'showing', 'shows', 'labeled', 'labelled', 'adjacent'
]);

export async function handleIntentMediaSearch(request, env) {
  if (request.method !== 'POST') return null;

  let input;
  try {
    input = await request.clone().json();
  } catch {
    return null;
  }

  const descriptions = normalizeDescriptions(input?.altTexts);
  if (input?.intentSearch !== true || descriptions.length === 0) return null;

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== requestUrl.origin) {
    return Response.json({ error: 'Cross-origin requests are not allowed.' }, { status: 403 });
  }

  const imageId = cleanText(input?.imageId, 160);
  const label = cleanText(input?.label, 240) || imageId || 'Lecture image';
  const fallbackQuery = buildFallbackQuery(label, imageId, descriptions);

  if (!env?.GEMINI_API_KEY) {
    return fallbackToEnhancedSearch(request, env, fallbackQuery, descriptions);
  }

  let intent;
  try {
    intent = await understandImageIntent({ descriptions, imageId, label }, env);
  } catch (error) {
    logIntentFallback('understand', error);
    return fallbackToEnhancedSearch(request, env, fallbackQuery, descriptions);
  }

  const candidateMap = new Map();
  const usedQueries = new Set();
  const queryQueue = [];
  enqueueQueries(queryQueue, usedQueries, intent.searchQueries);
  enqueueQueries(queryQueue, usedQueries, deterministicQueries(intent, descriptions, label, imageId));

  let rounds = 0;
  let usefulCount = 0;
  let geminiRankingAvailable = true;

  while (rounds < MAX_ROUNDS && usefulCount < TARGET_USEFUL_IMAGES && candidateMap.size < MAX_CANDIDATES) {
    const roundQueries = takeNextQueries(queryQueue, usedQueries, QUERIES_PER_ROUND);
    if (roundQueries.length === 0) break;
    rounds += 1;

    const settled = await Promise.allSettled(roundQueries.map((query) => searchWikimedia(query)));
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        console.warn(JSON.stringify({
          event: 'intent_media_search_commons_retry',
          query: roundQueries[index],
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        }));
        return;
      }
      mergeCandidates(candidateMap, result.value, roundQueries[index], intent, descriptions);
    });

    const candidates = [...candidateMap.values()].slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) continue;

    if (geminiRankingAvailable) {
      try {
        const ranking = await rankCandidates({
          descriptions,
          imageId,
          label,
          intent,
          candidates,
          usedQueries: [...usedQueries]
        }, env);
        applyGeminiRanking(candidates, ranking);
        enqueueQueries(queryQueue, usedQueries, ranking.nextQueries);
      } catch (error) {
        geminiRankingAvailable = false;
        logIntentFallback('ranking', error);
      }
    }

    rankLocally(candidates, intent, descriptions);
    usefulCount = candidates.filter((candidate) => candidate.usefulness >= USEFUL_SCORE).length;

    if (usefulCount < TARGET_USEFUL_IMAGES) {
      enqueueQueries(queryQueue, usedQueries, deterministicQueries(intent, descriptions, label, imageId));
    }
  }

  const rankedCandidates = [...candidateMap.values()];
  rankLocally(rankedCandidates, intent, descriptions);
  rankedCandidates.sort(compareCandidates);
  usefulCount = rankedCandidates.filter((candidate) => candidate.usefulness >= USEFUL_SCORE).length;

  if (rankedCandidates.length === 0) {
    return fallbackToEnhancedSearch(request, env, fallbackQuery, descriptions);
  }

  return Response.json({
    images: rankedCandidates.slice(0, MAX_RESPONSE_IMAGES).map((candidate) => candidate.url),
    usefulCount,
    intentSummary: intent.intentSummary,
    searchRounds: rounds,
    targetReached: usefulCount >= TARGET_USEFUL_IMAGES
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function understandImageIntent(context, env) {
  const prompt = [
    'You are planning Wikimedia Commons searches for one lecture image.',
    'Read every description together as evidence about the same intended image.',
    'Infer the shared visual subject, scientific process, important entities, and the most likely useful diagram or photograph type.',
    'Do not treat the descriptions as separate unrelated requests.',
    'Generate concise English Commons queries. Prefer accepted scientific names, pathway names, enzymes, diseases, structures, and conventional diagram terminology.',
    'Avoid full sentences and avoid repeating nearly identical queries.',
    `Image id: ${context.imageId || 'not provided'}`,
    `Visible label: ${context.label}`,
    `Descriptions: ${JSON.stringify(context.descriptions)}`,
    'Return an intent summary, key concepts, and six ordered search queries. Put the most promising query first.'
  ].join('\n');

  const result = await callGemini(prompt, {
    type: 'object',
    properties: {
      intentSummary: { type: 'string' },
      keyConcepts: { type: 'array', items: { type: 'string' } },
      searchQueries: { type: 'array', items: { type: 'string' } }
    },
    required: ['intentSummary', 'keyConcepts', 'searchQueries'],
    additionalProperties: false
  }, env, 320);

  const intentSummary = cleanText(result?.intentSummary, 600) || context.descriptions.join(' ').slice(0, 600);
  const keyConcepts = normalizeTerms(result?.keyConcepts, 10);
  const searchQueries = normalizeTerms(result?.searchQueries, 8);
  if (searchQueries.length === 0) throw stageError('Gemini returned no search queries.', 'gemini');

  return { intentSummary, keyConcepts, searchQueries };
}

async function rankCandidates(context, env) {
  const candidateList = context.candidates.map((candidate, index) => ({
    index,
    title: candidate.title,
    description: candidate.description,
    categories: candidate.categories,
    foundBy: [...candidate.searchQueries].slice(0, 3)
  }));

  const prompt = [
    'You rank Wikimedia Commons candidates for one intended lecture image.',
    'Use all descriptions and the inferred intent together.',
    'Score usefulness from 0 to 100. A score of 60 or more means the file is directly useful or a strong visual substitute.',
    'Prefer candidates that depict the exact pathway, structure, enzyme, disease, anatomy, reaction, or process.',
    'A candidate can still be useful when its title is broader than the description, provided it visibly represents the same core concept.',
    'Rank direct matches above partial matches and partial matches above merely related items.',
    'Return scores for every candidate. If fewer than three candidates deserve 60 or more, propose up to three new concise Commons queries targeting what is still missing.',
    `Image id: ${context.imageId || 'not provided'}`,
    `Visible label: ${context.label}`,
    `Descriptions: ${JSON.stringify(context.descriptions)}`,
    `Intent summary: ${context.intent.intentSummary}`,
    `Key concepts: ${JSON.stringify(context.intent.keyConcepts)}`,
    `Queries already used: ${JSON.stringify(context.usedQueries)}`,
    `Candidates: ${JSON.stringify(candidateList)}`
  ].join('\n');

  const result = await callGemini(prompt, {
    type: 'object',
    properties: {
      rankedCandidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            usefulness: { type: 'integer' }
          },
          required: ['index', 'usefulness'],
          additionalProperties: false
        }
      },
      nextQueries: { type: 'array', items: { type: 'string' } }
    },
    required: ['rankedCandidates', 'nextQueries'],
    additionalProperties: false
  }, env, 640);

  return {
    rankedCandidates: Array.isArray(result?.rankedCandidates) ? result.rankedCandidates : [],
    nextQueries: normalizeTerms(result?.nextQueries, 4)
  };
}

function applyGeminiRanking(candidates, ranking) {
  for (const item of ranking.rankedCandidates || []) {
    const index = Number(item?.index);
    const usefulness = Math.max(0, Math.min(100, Number(item?.usefulness) || 0));
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
    candidates[index].geminiUsefulness = usefulness;
    candidates[index].usefulness = Math.max(candidates[index].usefulness || 0, usefulness);
  }
}

async function searchWikimedia(searchTerm) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: searchTerm,
    gsrlimit: '12',
    gsrnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiextmetadatafilter: 'ImageDescription|ObjectName|Categories',
    iiurlwidth: '900',
    format: 'json'
  });

  const response = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${parameters}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': WIKIMEDIA_USER_AGENT,
      'Api-User-Agent': WIKIMEDIA_USER_AGENT
    }
  });

  if (!response.ok) throw stageError(`Wikimedia Commons returned ${response.status}.`, 'wikimedia');
  const payload = await response.json();
  if (payload?.error) throw stageError(`Wikimedia Commons API error: ${payload.error.code || 'unknown'}.`, 'wikimedia');

  const candidates = [];
  let sourceOrder = 0;
  for (const page of Object.values(payload?.query?.pages || {})) {
    const imageInfo = page?.imageinfo?.[0];
    if (!imageInfo || (typeof imageInfo.mime === 'string' && !imageInfo.mime.startsWith('image/'))) continue;
    const value = imageInfo.thumburl || imageInfo.url;
    if (typeof value !== 'string') continue;

    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') continue;
      const metadata = imageInfo.extmetadata || {};
      candidates.push({
        url: url.href,
        title: sanitizeTitle(page?.title),
        description: stripMarkup(metadata.ImageDescription?.value || metadata.ObjectName?.value || '').slice(0, 360),
        categories: stripMarkup(metadata.Categories?.value || '').replace(/\|/g, ', ').slice(0, 240),
        sourceOrder
      });
      sourceOrder += 1;
    } catch {
      // Ignore malformed Commons entries.
    }
  }
  return candidates;
}

function mergeCandidates(candidateMap, incoming, searchQuery, intent, descriptions) {
  for (const candidate of incoming || []) {
    const existing = candidateMap.get(candidate.url);
    if (existing) {
      existing.searchQueries.add(searchQuery);
      existing.localScore = Math.max(existing.localScore, localCandidateScore(existing, intent, descriptions, searchQuery));
      continue;
    }
    if (candidateMap.size >= MAX_CANDIDATES) break;
    const value = {
      ...candidate,
      searchQueries: new Set([searchQuery]),
      geminiUsefulness: null,
      usefulness: 0,
      localScore: 0
    };
    value.localScore = localCandidateScore(value, intent, descriptions, searchQuery);
    candidateMap.set(candidate.url, value);
  }
}

function rankLocally(candidates, intent, descriptions) {
  for (const candidate of candidates) {
    const localUsefulness = Math.max(0, Math.min(59, Math.round(candidate.localScore)));
    candidate.usefulness = Math.max(candidate.usefulness || 0, localUsefulness);
  }
}

function compareCandidates(left, right) {
  return (right.usefulness - left.usefulness)
    || (right.localScore - left.localScore)
    || (left.sourceOrder - right.sourceOrder);
}

function localCandidateScore(candidate, intent, descriptions, searchQuery) {
  const haystack = normalizeTerm(`${candidate.title} ${candidate.description} ${candidate.categories}`);
  const coreTokens = meaningfulTokens(`${intent.intentSummary} ${intent.keyConcepts.join(' ')} ${descriptions.join(' ')}`);
  const queryTokens = meaningfulTokens(searchQuery);
  let score = Math.max(0, 12 - candidate.sourceOrder);

  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 9;
  }
  for (const token of coreTokens) {
    if (haystack.includes(token)) score += 2.5;
  }
  if (/diagram|pathway|reaction|synthesis|metabolism|anatomy|medical|biochem|structure/i.test(`${candidate.title} ${candidate.description}`)) score += 5;
  return score;
}

function deterministicQueries(intent, descriptions, label, imageId) {
  const values = [
    ...intent.searchQueries,
    ...intent.keyConcepts,
    label,
    imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' '),
    ...descriptions
  ];
  const tokens = meaningfulTokens(values.join(' '));
  const queries = [];

  const add = (value) => {
    const term = cleanSearchTerm(value);
    if (term && !queries.some((item) => normalizeTerm(item) === normalizeTerm(term))) queries.push(term);
  };

  intent.keyConcepts.forEach(add);
  add(label);
  add(imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' '));
  for (let index = 0; index < tokens.length; index += 1) {
    add(tokens.slice(index, index + 3).join(' '));
    if (queries.length >= MAX_SEARCH_QUERIES) break;
  }
  return queries.slice(0, MAX_SEARCH_QUERIES);
}

function enqueueQueries(queue, usedQueries, values) {
  for (const value of values || []) {
    const term = cleanSearchTerm(value);
    const normalized = normalizeTerm(term);
    if (!term || usedQueries.has(normalized) || queue.some((item) => normalizeTerm(item) === normalized)) continue;
    queue.push(term);
    if (queue.length >= MAX_SEARCH_QUERIES) break;
  }
}

function takeNextQueries(queue, usedQueries, limit) {
  const output = [];
  while (queue.length && output.length < limit) {
    const term = queue.shift();
    const normalized = normalizeTerm(term);
    if (!normalized || usedQueries.has(normalized)) continue;
    usedQueries.add(normalized);
    output.push(term);
  }
  return output;
}

async function fallbackToEnhancedSearch(request, env, fallbackQuery, descriptions) {
  const fallbackRequest = new Request(request.url, {
    method: 'POST',
    headers: buildFallbackHeaders(request),
    body: JSON.stringify({ query: fallbackQuery })
  });
  const response = await handleEnhancedMediaSearch(fallbackRequest, env);
  if (response.status !== 200) return response;
  const payload = await response.json().catch(() => ({ images: [] }));
  return Response.json({
    images: Array.isArray(payload.images) ? payload.images : [],
    usefulCount: 0,
    intentSummary: descriptions.join(' ').slice(0, 600),
    searchRounds: 0,
    targetReached: false,
    fallback: true
  }, { headers: { 'Cache-Control': 'no-store' } });
}

function buildFallbackHeaders(request) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const origin = request.headers.get('Origin');
  if (origin) headers.set('Origin', origin);
  return headers;
}

function buildFallbackQuery(label, imageId, descriptions) {
  return cleanSearchTerm(`${label} ${imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' ')} ${descriptions[0]}`)
    || cleanSearchTerm(descriptions.join(' '));
}

async function callGemini(prompt, responseSchema, env, maxOutputTokens) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens,
        responseFormat: {
          text: {
            mimeType: 'application/json',
            schema: responseSchema
          }
        }
      }
    })
  });

  if (!response.ok) throw stageError(`Gemini returned ${response.status}.`, 'gemini');
  const payload = await response.json();
  const responseText = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(responseText);
  } catch {
    throw stageError('Gemini did not return the required structured result.', 'gemini');
  }
}

function normalizeDescriptions(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = cleanText(value, 1200);
    const normalized = normalizeTerm(text);
    if (!text || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(text);
    if (output.length >= 8) break;
  }
  return output;
}

function normalizeTerms(values, limit) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const term = cleanSearchTerm(value);
    const normalized = normalizeTerm(term);
    if (!term || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(term);
    if (output.length >= limit) break;
  }
  return output;
}

function cleanSearchTerm(value) {
  return cleanText(value, 160)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—,:;]+|[-–—,:;]+$/g, '')
    .trim();
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function meaningfulTokens(value) {
  return [...new Set((normalizeTerm(value).match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => token.length >= 3 && token.length <= 32 && !STOP_WORDS.has(token)))];
}

function normalizeTerm(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function sanitizeTitle(value) {
  return String(value || '')
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stageError(message, stage) {
  const error = new Error(message);
  error.stage = stage;
  return error;
}

function logIntentFallback(stage, error) {
  console.warn(JSON.stringify({
    event: 'intent_media_search_fallback',
    stage,
    message: error instanceof Error ? error.message : String(error)
  }));
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

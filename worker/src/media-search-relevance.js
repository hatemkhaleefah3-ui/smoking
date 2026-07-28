import { handleEnhancedMediaSearch } from './media-search-enhanced.js';
import { handleIntentMediaSearch as handleOrderedIntentMediaSearch } from './media-search-intent.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const STRICT_RELEVANCE_SCORE = 65;
const LOCAL_RELEVANCE_SCORE = 26;
const MAX_CANDIDATES = 80;
const MAX_RESPONSE_IMAGES = 40;
const METADATA_BATCH_SIZE = 20;
const RANK_BATCH_SIZE = 16;
const MAX_LABEL_QUERIES = 5;
const REQUEST_TIMEOUT_MS = 12_000;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherRelevanceFilter/1.0 (https://github.com/hatemkhaleefah3-ui/smoking)';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with',
  'adjacent', 'annotated', 'block', 'conversion', 'diagram', 'figure', 'image', 'illustration', 'labeled', 'labelled', 'panel',
  'photo', 'photograph', 'picture', 'showing', 'shows', 'through', 'using'
]);

export async function handleRelevantIntentMediaSearch(request, env) {
  if (request.method !== 'POST') return handleOrderedIntentMediaSearch(request, env);

  let input;
  try {
    input = await request.clone().json();
  } catch {
    return handleOrderedIntentMediaSearch(request, env);
  }

  if (input?.intentSearch !== true || input?.strictRelevance !== true) {
    return handleOrderedIntentMediaSearch(request, env);
  }

  const label = cleanText(input?.label, 240) || cleanText(input?.imageId, 160) || 'Lecture image';
  const imageId = cleanText(input?.imageId, 160);
  const altTexts = normalizeTexts(input?.altTexts, 8, 1200);
  if (altTexts.length === 0) return handleOrderedIntentMediaSearch(request, env);

  const orderedResponse = await handleOrderedIntentMediaSearch(request, env);
  if (!orderedResponse || orderedResponse.status !== 200) return orderedResponse;

  const orderedPayload = await orderedResponse.clone().json().catch(() => null);
  if (!orderedPayload || !Array.isArray(orderedPayload.images)) return orderedResponse;

  let geminiAvailable = Boolean(env?.GEMINI_API_KEY);
  const intentSummary = cleanText(orderedPayload.intentSummary, 900) || altTexts.join(' ').slice(0, 900);
  const discoveredUrls = uniqueHttpsUrls(orderedPayload.images).slice(0, MAX_CANDIDATES);
  let candidates = await enrichCandidates(discoveredUrls);
  let ranked = await rankAndFilter({ candidates, label, imageId, altTexts, intentSummary, env, geminiAvailable });
  geminiAvailable = ranked.geminiAvailable;

  let strictLabelFallbackUsed = false;
  let strictLabelQueries = [];

  if (ranked.relevant.length === 0) {
    strictLabelFallbackUsed = true;
    if (geminiAvailable) {
      try {
        strictLabelQueries = await generateLabelQueries({ label, imageId, altTexts, intentSummary }, env);
      } catch (error) {
        geminiAvailable = false;
        logFallback('label-query-generation', error);
      }
    }
    if (strictLabelQueries.length === 0) {
      strictLabelQueries = deterministicLabelQueries(label, imageId, altTexts);
    }

    const fallbackUrls = [];
    const seen = new Set(discoveredUrls);
    for (const query of strictLabelQueries) {
      const response = await handleEnhancedMediaSearch(buildSearchRequest(request, query), env);
      if (response.status !== 200) continue;
      const payload = await response.json().catch(() => ({ images: [] }));
      for (const url of uniqueHttpsUrls(payload.images)) {
        if (seen.has(url) || seen.size >= MAX_CANDIDATES) continue;
        seen.add(url);
        fallbackUrls.push(url);
      }
    }

    candidates = await enrichCandidates([...discoveredUrls, ...fallbackUrls]);
    ranked = await rankAndFilter({ candidates, label, imageId, altTexts, intentSummary, env, geminiAvailable });
    geminiAvailable = ranked.geminiAvailable;
  }

  return Response.json({
    ...orderedPayload,
    images: ranked.relevant.slice(0, MAX_RESPONSE_IMAGES).map((candidate) => candidate.url),
    usefulCount: ranked.relevant.length,
    targetReached: ranked.relevant.length >= 3,
    strictRelevance: true,
    strictLabelFallbackUsed,
    strictLabelQueries,
    filteredCount: ranked.filteredCount
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function rankAndFilter(context) {
  for (const candidate of context.candidates) {
    const local = localScore(candidate, context.label, context.imageId, context.altTexts, context.intentSummary);
    candidate.localScore = local.score;
    candidate.hasCoreMatch = local.hasCoreMatch;
    candidate.geminiUsefulness = null;
  }

  let geminiAvailable = context.geminiAvailable;
  if (context.candidates.length > 0 && geminiAvailable) {
    for (let offset = 0; offset < context.candidates.length; offset += RANK_BATCH_SIZE) {
      const batch = context.candidates.slice(offset, offset + RANK_BATCH_SIZE);
      try {
        const ranking = await rankCandidates({ ...context, candidates: batch }, context.env);
        applyRanking(batch, ranking);
      } catch (error) {
        geminiAvailable = false;
        logFallback('candidate-ranking', error);
        break;
      }
    }
  }

  context.candidates.sort((left, right) => {
    const leftScore = Number.isFinite(left.geminiUsefulness) ? left.geminiUsefulness : left.localScore;
    const rightScore = Number.isFinite(right.geminiUsefulness) ? right.geminiUsefulness : right.localScore;
    return rightScore - leftScore || right.localScore - left.localScore || left.sourceOrder - right.sourceOrder;
  });

  const relevant = context.candidates.filter((candidate) => {
    if (geminiAvailable && Number.isFinite(candidate.geminiUsefulness)) {
      return candidate.geminiUsefulness >= STRICT_RELEVANCE_SCORE;
    }
    return candidate.hasCoreMatch && candidate.localScore >= LOCAL_RELEVANCE_SCORE;
  });

  return {
    relevant,
    filteredCount: Math.max(0, context.candidates.length - relevant.length),
    geminiAvailable
  };
}

async function rankCandidates(context, env) {
  const list = context.candidates.map((candidate, index) => ({
    index,
    title: candidate.title,
    description: candidate.description,
    categories: candidate.categories
  }));

  const prompt = [
    'Strictly filter Wikimedia Commons candidates for a medical or scientific lecture image carousel.',
    'The visible label and all alt texts define one intended image.',
    'Many candidates came from generic discovery phrases such as "Diagram showing" or "Pathway illustrating".',
    'Do not treat being returned by Wikimedia as evidence of relevance.',
    'Judge the actual file title, description, and categories.',
    'Score each candidate from 0 to 100.',
    '65 or more means it directly depicts the requested subject or is a strong visual substitute.',
    'Below 65 means unrelated, random, decorative, too broad, or depicts a different structure, disease, pathway, organism, or process.',
    'Be conservative. It is better to return no image than a misleading image.',
    `Visible label: ${context.label}`,
    `Image id: ${context.imageId || 'not provided'}`,
    `All alt texts: ${JSON.stringify(context.altTexts)}`,
    `Understood image intent: ${context.intentSummary}`,
    `Candidates: ${JSON.stringify(list)}`
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
      }
    },
    required: ['rankedCandidates'],
    additionalProperties: false
  }, env, 700);

  return Array.isArray(result?.rankedCandidates) ? result.rankedCandidates : [];
}

function applyRanking(candidates, ranking) {
  for (const item of ranking || []) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
    candidates[index].geminiUsefulness = Math.max(0, Math.min(100, Number(item?.usefulness) || 0));
  }
}

async function generateLabelQueries(context, env) {
  const prompt = [
    'The ordered alt-text Wikimedia searches returned files, but strict semantic filtering found no relevant image.',
    'Generate concise English Wikimedia Commons search phrases from the visible image label and the combined image intent.',
    'Use exact medical, biochemical, anatomical, pathological, pharmacological, or scientific terminology.',
    'Avoid generic standalone words such as diagram, image, showing, pathway, illustration, chart, or figure.',
    'Return up to five distinct phrases, strongest first.',
    `Visible label: ${context.label}`,
    `Image id: ${context.imageId || 'not provided'}`,
    `All alt texts: ${JSON.stringify(context.altTexts)}`,
    `Understood image intent: ${context.intentSummary}`
  ].join('\n');

  const result = await callGemini(prompt, {
    type: 'object',
    properties: {
      searchQueries: { type: 'array', items: { type: 'string' } }
    },
    required: ['searchQueries'],
    additionalProperties: false
  }, env, 320);

  return normalizeTexts(result?.searchQueries, MAX_LABEL_QUERIES, 180);
}

function deterministicLabelQueries(label, imageId, altTexts) {
  const output = [];
  const add = (value) => {
    const term = cleanText(value, 180).replace(/\s+/g, ' ').trim();
    const normalized = normalize(term);
    if (!term || output.some((item) => normalize(item) === normalized)) return;
    output.push(term);
  };
  add(label);
  add(imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' '));
  for (const text of altTexts) {
    const concepts = meaningfulTokens(text).slice(0, 5).join(' ');
    if (concepts) add(`${label} ${concepts}`);
  }
  return output.slice(0, MAX_LABEL_QUERIES);
}

async function enrichCandidates(urls) {
  const base = urls.slice(0, MAX_CANDIDATES).map((url, sourceOrder) => ({
    url,
    title: titleFromUploadUrl(url),
    description: '',
    categories: '',
    sourceOrder
  }));
  const titleMap = new Map(base.filter((item) => item.title).map((item) => [normalize(item.title), item]));
  const titled = base.filter((item) => item.title);

  for (let offset = 0; offset < titled.length; offset += METADATA_BATCH_SIZE) {
    const batch = titled.slice(offset, offset + METADATA_BATCH_SIZE);
    try {
      const metadata = await fetchCommonsMetadata(batch.map((item) => item.title));
      for (const item of metadata) {
        const target = titleMap.get(normalize(item.title));
        if (!target) continue;
        target.description = item.description;
        target.categories = item.categories;
      }
    } catch (error) {
      logFallback('commons-metadata', error);
    }
  }

  return base;
}

async function fetchCommonsMetadata(titles) {
  const parameters = new URLSearchParams({
    action: 'query',
    titles: titles.map((title) => `File:${title}`).join('|'),
    prop: 'imageinfo',
    iiprop: 'extmetadata',
    iiextmetadatafilter: 'ImageDescription|ObjectName|Categories',
    format: 'json'
  });
  const response = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${parameters}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': WIKIMEDIA_USER_AGENT,
      'Api-User-Agent': WIKIMEDIA_USER_AGENT
    }
  });
  if (!response.ok) throw new Error(`Wikimedia metadata returned ${response.status}.`);
  const payload = await response.json();
  const output = [];
  for (const page of Object.values(payload?.query?.pages || {})) {
    const metadata = page?.imageinfo?.[0]?.extmetadata || {};
    output.push({
      title: sanitizeTitle(page?.title),
      description: stripMarkup(metadata.ImageDescription?.value || metadata.ObjectName?.value || '').slice(0, 500),
      categories: stripMarkup(metadata.Categories?.value || '').replace(/\|/g, ', ').slice(0, 350)
    });
  }
  return output;
}

function localScore(candidate, label, imageId, altTexts, intentSummary) {
  const haystack = normalize(`${candidate.title} ${candidate.description} ${candidate.categories}`);
  const labelTokens = meaningfulTokens(`${label} ${imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' ')}`);
  const intentTokens = meaningfulTokens(`${intentSummary} ${altTexts.join(' ')}`);
  let score = Math.max(0, 7 - candidate.sourceOrder);
  let coreMatches = 0;

  for (const token of labelTokens) {
    if (haystack.includes(token)) {
      score += 17;
      coreMatches += 1;
    }
  }
  for (const token of intentTokens) {
    if (haystack.includes(token)) {
      score += 4;
      coreMatches += 1;
    }
  }
  if (normalize(label).length >= 5 && haystack.includes(normalize(label))) score += 30;
  return { score, hasCoreMatch: coreMatches > 0 };
}

function buildSearchRequest(request, query) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const origin = request.headers.get('Origin');
  if (origin) headers.set('Origin', origin);
  return new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query })
  });
}

function uniqueHttpsUrls(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || seen.has(url.href)) continue;
      seen.add(url.href);
      output.push(url.href);
    } catch {
    }
  }
  return output;
}

function titleFromUploadUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const thumbIndex = segments.indexOf('thumb');
    const raw = thumbIndex >= 0 && segments.length >= 2 ? segments[segments.length - 2] : segments[segments.length - 1];
    return sanitizeTitle(raw || '');
  } catch {
    return '';
  }
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
  if (!response.ok) throw new Error(`Gemini returned ${response.status}.`);
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini did not return the required structured result.');
  }
}

function normalizeTexts(values, limit, length) {
  if (!Array.isArray(values)) return [];
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const text = cleanText(value, length).replace(/\s+/g, ' ').trim();
    const normalized = normalize(text);
    if (!text || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function meaningfulTokens(value) {
  return [...new Set((normalize(value).match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => token.length >= 3 && token.length <= 32 && !STOP_WORDS.has(token)))];
}

function normalize(value) {
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

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function logFallback(stage, error) {
  console.warn(JSON.stringify({
    event: 'strict_media_relevance_fallback',
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

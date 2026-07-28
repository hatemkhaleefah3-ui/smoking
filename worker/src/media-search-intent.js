const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_ALT_TEXTS = 8;
const MAX_CANDIDATES = 80;
const MAX_RESPONSE_IMAGES = 80;
const MAX_RESULTS_PER_QUERY = 10;
const RANK_BATCH_SIZE = 18;
const LABEL_FALLBACK_QUERIES = 6;
const USEFUL_SCORE = 60;
const REQUEST_TIMEOUT_MS = 12_000;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherIntentSearch/1.1 (https://github.com/hatemkhaleefah3-ui/smoking)';

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
  let geminiAvailable = Boolean(env?.GEMINI_API_KEY);
  let intent = {
    intentSummary: descriptions.join(' ').slice(0, 800),
    keyConcepts: meaningfulTokens(`${label} ${imageId} ${descriptions.join(' ')}`).slice(0, 12)
  };

  if (geminiAvailable) {
    try {
      intent = await understandImageIntent({ descriptions, imageId, label }, env);
    } catch (error) {
      geminiAvailable = false;
      logIntentFallback('understand', error);
    }
  }

  const candidateMap = new Map();
  const queryCache = new Map();
  const searchPlan = buildAltTextSearchPlan(descriptions);
  const executedQueries = [];

  for (const item of searchPlan) {
    const candidates = await searchWithCache(item.query, queryCache).catch((error) => {
      console.warn(JSON.stringify({
        event: 'ordered_alttext_commons_search',
        query: item.query,
        mode: item.mode,
        altIndex: item.altIndex,
        message: error instanceof Error ? error.message : String(error)
      }));
      return [];
    });
    executedQueries.push(item.query);
    mergeCandidates(candidateMap, candidates, item, intent, descriptions, label, imageId);
  }

  let labelFallbackUsed = false;
  let generatedQueries = [];

  if (candidateMap.size === 0) {
    labelFallbackUsed = true;
    if (geminiAvailable) {
      try {
        generatedQueries = await generateLabelQueries({ descriptions, imageId, label, intent }, env);
      } catch (error) {
        geminiAvailable = false;
        logIntentFallback('label-queries', error);
      }
    }
    if (generatedQueries.length === 0) {
      generatedQueries = deterministicLabelQueries(label, imageId, intent);
    }

    for (const query of generatedQueries) {
      const candidates = await searchWithCache(query, queryCache).catch((error) => {
        console.warn(JSON.stringify({
          event: 'label_fallback_commons_search',
          query,
          message: error instanceof Error ? error.message : String(error)
        }));
        return [];
      });
      executedQueries.push(query);
      mergeCandidates(
        candidateMap,
        candidates,
        { query, mode: 'label-generated', altIndex: -1 },
        intent,
        descriptions,
        label,
        imageId
      );
    }
  }

  const candidates = [...candidateMap.values()];
  rankLocally(candidates, intent, descriptions, label, imageId);

  if (candidates.length > 0 && geminiAvailable) {
    for (let offset = 0; offset < candidates.length; offset += RANK_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + RANK_BATCH_SIZE);
      try {
        const ranking = await rankCandidateBatch({
          descriptions,
          imageId,
          label,
          intent,
          candidates: batch
        }, env);
        applyGeminiRanking(batch, ranking);
      } catch (error) {
        geminiAvailable = false;
        logIntentFallback('ranking', error);
        break;
      }
    }
  }

  candidates.sort(compareCandidates);
  const usefulCount = candidates.filter((candidate) => candidate.usefulness >= USEFUL_SCORE).length;

  return Response.json({
    images: candidates.slice(0, MAX_RESPONSE_IMAGES).map((candidate) => candidate.url),
    usefulCount,
    intentSummary: intent.intentSummary,
    searchRounds: searchPlan.length + generatedQueries.length,
    targetReached: usefulCount >= 3,
    labelFallbackUsed,
    searchedQueries: executedQueries
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function understandImageIntent(context, env) {
  const prompt = [
    'You are interpreting all descriptions of one intended lecture image.',
    'Read every alt text together. They describe the same desired visual.',
    'Summarize the shared visual content and list the most important scientific concepts.',
    'Do not create search queries in this step.',
    `Image id: ${context.imageId || 'not provided'}`,
    `Visible image label: ${context.label}`,
    `Alt texts: ${JSON.stringify(context.descriptions)}`
  ].join('\n');

  const result = await callGemini(prompt, {
    type: 'object',
    properties: {
      intentSummary: { type: 'string' },
      keyConcepts: { type: 'array', items: { type: 'string' } }
    },
    required: ['intentSummary', 'keyConcepts'],
    additionalProperties: false
  }, env, 320);

  return {
    intentSummary: cleanText(result?.intentSummary, 800) || context.descriptions.join(' ').slice(0, 800),
    keyConcepts: normalizeTerms(result?.keyConcepts, 12)
  };
}

function buildAltTextSearchPlan(descriptions) {
  const plan = [];
  descriptions.forEach((description, altIndex) => {
    const firstTwo = firstWords(description, 2);
    if (firstTwo) plan.push({ query: firstTwo, mode: 'first-two', altIndex });
    const full = cleanFullSearchTerm(description);
    if (full) plan.push({ query: full, mode: 'full-alt', altIndex });
  });
  return plan;
}

function firstWords(value, count) {
  const words = String(value || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || [];
  return words.slice(0, count).join(' ').trim();
}

async function generateLabelQueries(context, env) {
  const prompt = [
    'No Wikimedia Commons images were found after searching every alt text in its required order.',
    'Create concise English Wikimedia Commons search phrases based mainly on the visible image label.',
    'Use the understood image intent and scientific terminology only to clarify the label.',
    'Return diverse phrases, not full sentences, and do not repeat the original alt texts.',
    `Visible image label: ${context.label}`,
    `Image id: ${context.imageId || 'not provided'}`,
    `Understood intent: ${context.intent.intentSummary}`,
    `Key concepts: ${JSON.stringify(context.intent.keyConcepts)}`,
    `Alt texts: ${JSON.stringify(context.descriptions)}`
  ].join('\n');

  const result = await callGemini(prompt, {
    type: 'object',
    properties: {
      searchQueries: { type: 'array', items: { type: 'string' } }
    },
    required: ['searchQueries'],
    additionalProperties: false
  }, env, 320);

  return normalizeTerms(result?.searchQueries, LABEL_FALLBACK_QUERIES);
}

async function rankCandidateBatch(context, env) {
  const candidateList = context.candidates.map((candidate, index) => ({
    index,
    title: candidate.title,
    description: candidate.description,
    categories: candidate.categories,
    foundBy: [...candidate.searchQueries],
    firstFoundBy: candidate.firstSearchMode
  }));

  const prompt = [
    'Rank Wikimedia Commons images for one lecture image carousel.',
    'The visible image label is the primary ranking target.',
    'Use all alt texts and the understood intent as supporting evidence.',
    'Score every candidate from 0 to 100 for how closely it represents the image label.',
    'Direct visual matches come first, then useful partial matches, then merely related images.',
    'Do not remove candidates; score every listed candidate so all collected images can remain visible.',
    `Visible image label: ${context.label}`,
    `Image id: ${context.imageId || 'not provided'}`,
    `Alt texts: ${JSON.stringify(context.descriptions)}`,
    `Understood intent: ${context.intent.intentSummary}`,
    `Key concepts: ${JSON.stringify(context.intent.keyConcepts)}`,
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
      }
    },
    required: ['rankedCandidates'],
    additionalProperties: false
  }, env, 700);

  return Array.isArray(result?.rankedCandidates) ? result.rankedCandidates : [];
}

function applyGeminiRanking(candidates, ranking) {
  for (const item of ranking || []) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
    const usefulness = Math.max(0, Math.min(100, Number(item?.usefulness) || 0));
    candidates[index].geminiUsefulness = usefulness;
    candidates[index].usefulness = usefulness;
  }
}

async function searchWithCache(query, cache) {
  const key = normalizeTerm(query);
  if (!key) return [];
  if (!cache.has(key)) cache.set(key, searchWikimedia(query));
  return cache.get(key);
}

async function searchWikimedia(searchTerm) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: searchTerm,
    gsrlimit: String(MAX_RESULTS_PER_QUERY),
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
        description: stripMarkup(metadata.ImageDescription?.value || metadata.ObjectName?.value || '').slice(0, 420),
        categories: stripMarkup(metadata.Categories?.value || '').replace(/\|/g, ', ').slice(0, 300),
        sourceOrder
      });
      sourceOrder += 1;
    } catch {
      // Ignore malformed Commons entries.
    }
  }
  return candidates;
}

function mergeCandidates(candidateMap, incoming, searchItem, intent, descriptions, label, imageId) {
  for (const candidate of incoming || []) {
    const existing = candidateMap.get(candidate.url);
    if (existing) {
      existing.searchQueries.add(searchItem.query);
      existing.localScore = Math.max(
        existing.localScore,
        localCandidateScore(existing, intent, descriptions, label, imageId, searchItem.query)
      );
      continue;
    }
    if (candidateMap.size >= MAX_CANDIDATES) continue;
    const value = {
      ...candidate,
      searchQueries: new Set([searchItem.query]),
      firstSearchMode: searchItem.mode,
      firstAltIndex: searchItem.altIndex,
      firstSeenOrder: candidateMap.size,
      geminiUsefulness: null,
      usefulness: 0,
      localScore: 0
    };
    value.localScore = localCandidateScore(value, intent, descriptions, label, imageId, searchItem.query);
    candidateMap.set(candidate.url, value);
  }
}

function rankLocally(candidates, intent, descriptions, label, imageId) {
  for (const candidate of candidates) {
    candidate.localScore = Math.max(
      candidate.localScore,
      localCandidateScore(candidate, intent, descriptions, label, imageId, [...candidate.searchQueries].join(' '))
    );
    candidate.usefulness = Math.max(candidate.usefulness || 0, Math.max(0, Math.min(59, Math.round(candidate.localScore))));
  }
}

function localCandidateScore(candidate, intent, descriptions, label, imageId, searchQuery) {
  const haystack = normalizeTerm(`${candidate.title} ${candidate.description} ${candidate.categories}`);
  const labelTokens = meaningfulTokens(`${label} ${imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' ')}`);
  const intentTokens = meaningfulTokens(`${intent.intentSummary} ${intent.keyConcepts.join(' ')} ${descriptions.join(' ')}`);
  const queryTokens = meaningfulTokens(searchQuery);
  let score = Math.max(0, 10 - candidate.sourceOrder);

  for (const token of labelTokens) {
    if (haystack.includes(token)) score += 13;
  }
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 5;
  }
  for (const token of intentTokens) {
    if (haystack.includes(token)) score += 2;
  }
  if (/diagram|pathway|reaction|synthesis|metabolism|anatomy|medical|biochem|structure/i.test(`${candidate.title} ${candidate.description}`)) score += 4;
  return score;
}

function compareCandidates(left, right) {
  return (right.usefulness - left.usefulness)
    || (right.localScore - left.localScore)
    || (left.firstSeenOrder - right.firstSeenOrder);
}

function deterministicLabelQueries(label, imageId, intent) {
  const output = [];
  const add = (value) => {
    const query = cleanGeneratedSearchTerm(value);
    const normalized = normalizeTerm(query);
    if (!query || output.some((item) => normalizeTerm(item) === normalized)) return;
    output.push(query);
  };

  add(label);
  add(imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' '));
  for (const concept of intent.keyConcepts || []) add(`${label} ${concept}`);
  return output.slice(0, LABEL_FALLBACK_QUERIES);
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
    if (output.length >= MAX_ALT_TEXTS) break;
  }
  return output;
}

function normalizeTerms(values, limit) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const term = cleanGeneratedSearchTerm(value);
    const normalized = normalizeTerm(term);
    if (!term || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(term);
    if (output.length >= limit) break;
  }
  return output;
}

function cleanFullSearchTerm(value) {
  return cleanText(value, 900)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanGeneratedSearchTerm(value) {
  return cleanText(value, 180)
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

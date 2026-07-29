import { handleMediaSearch as handleBaseMediaSearch } from './media-search.js';

const MAX_ENHANCED_IMAGES = 18;
const TARGET_CAROUSEL_IMAGES = 10;
const MAX_FALLBACK_QUERIES = 5;
const MAX_DIRECT_CANDIDATES = 16;
const MAX_DIRECT_PER_QUERY = 8;
const DESCRIPTIVE_QUERY_LENGTH = 64;
const DESCRIPTIVE_TOKEN_COUNT = 7;
const REQUEST_TIMEOUT_MS = 12_000;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherMediaSearch/1.7 (https://github.com/hatemkhaleefah3-ui/smoking)';

const FALLBACK_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with',
  'adjacent', 'annotated', 'block', 'blocked', 'causing', 'conversion', 'converted', 'depicts', 'dependent', 'diagram', 'due',
  'finally', 'halting', 'image', 'illustration', 'labeled', 'labelled', 'producing', 'showing', 'shows', 'through', 'using',
  'file', 'photo', 'photograph', 'picture', 'png', 'jpg', 'jpeg', 'svg'
]);

const SCIENTIFIC_SUFFIX = /(?:ase|emia|genic|genesis|ide|ine|itis|lysis|oma|one|osis|pathway|phosphate|synthesis|yl)$/i;

export async function handleEnhancedMediaSearch(request, env) {
  if (request.method !== 'POST') return handleBaseMediaSearch(request, env);

  let input;
  try {
    input = await request.clone().json();
  } catch {
    return handleBaseMediaSearch(request, env);
  }

  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  const baseResponse = await handleBaseMediaSearch(request, env);
  if (!query || baseResponse.status !== 200) return baseResponse;

  const basePayload = await baseResponse.clone().json().catch(() => null);
  if (!basePayload || !Array.isArray(basePayload.images)) return baseResponse;

  const images = [];
  const seenImages = new Set();
  appendImages(images, seenImages, basePayload.images);

  const fallbackQueries = buildFallbackQueries(query);
  if (!shouldExpandQuery(query, fallbackQueries, images.length)) {
    return baseResponse;
  }

  for (const fallbackQuery of fallbackQueries) {
    if (images.length >= MAX_ENHANCED_IMAGES) break;

    let candidates;
    try {
      candidates = await searchWikimediaBroadly(fallbackQuery, query);
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'media_search_broad_fallback',
        query: fallbackQuery,
        message: error instanceof Error ? error.message : String(error)
      }));
      continue;
    }

    appendImages(images, seenImages, candidates.map((candidate) => candidate.url));
    if (images.length >= TARGET_CAROUSEL_IMAGES) break;
  }

  return Response.json(
    { images: images.slice(0, MAX_ENHANCED_IMAGES) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

function shouldExpandQuery(query, fallbackQueries, imageCount) {
  if (!fallbackQueries.length || imageCount >= TARGET_CAROUSEL_IMAGES) return false;
  const tokens = tokenize(query);
  return imageCount < 3 || query.length >= DESCRIPTIVE_QUERY_LENGTH || tokens.length >= DESCRIPTIVE_TOKEN_COUNT;
}

async function searchWikimediaBroadly(searchTerm, originalQuery) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: searchTerm,
    gsrlimit: String(MAX_DIRECT_CANDIDATES),
    gsrnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url|mime',
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

  if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}.`);
  const payload = await response.json();
  if (payload?.error) throw new Error(`Wikimedia Commons API error: ${payload.error.code || 'unknown'}.`);

  const candidates = [];
  const seen = new Set();
  let sourceOrder = 0;

  for (const page of Object.values(payload?.query?.pages || {})) {
    const imageInfo = page?.imageinfo?.[0];
    if (!imageInfo || (typeof imageInfo.mime === 'string' && !imageInfo.mime.startsWith('image/'))) continue;
    const value = imageInfo.thumburl || imageInfo.url;
    if (typeof value !== 'string') continue;

    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || seen.has(url.href)) continue;
      seen.add(url.href);
      const title = sanitizeTitle(page?.title);
      candidates.push({
        url: url.href,
        title,
        score: scoreCandidate(title, originalQuery, searchTerm, sourceOrder),
        sourceOrder
      });
      sourceOrder += 1;
    } catch {
      // Ignore malformed Commons entries.
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.sourceOrder - right.sourceOrder)
    .slice(0, MAX_DIRECT_PER_QUERY);
}

function scoreCandidate(title, originalQuery, searchTerm, sourceOrder) {
  const normalizedTitle = normalizeTerm(title);
  const searchTokens = meaningfulTokens(searchTerm);
  const originalTokens = meaningfulTokens(originalQuery);
  let score = Math.max(0, 12 - sourceOrder);

  if (normalizedTitle.includes(normalizeTerm(searchTerm))) score += 40;
  for (const token of searchTokens) {
    if (normalizedTitle.includes(token)) score += 12;
    else if (token.length >= 6 && normalizedTitle.includes(token.slice(0, -1))) score += 5;
  }
  for (const token of originalTokens) {
    if (normalizedTitle.includes(token)) score += 3;
  }
  if (/diagram|pathway|reaction|synthesis|metabolism|anatomy|medical|biochem/i.test(title)) score += 4;
  return score;
}

function appendImages(target, seen, values) {
  for (const value of values || []) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    target.push(value);
    if (target.length >= MAX_ENHANCED_IMAGES) break;
  }
}

function buildFallbackQueries(query) {
  const tokens = tokenize(query).filter((token) => !FALLBACK_STOP_WORDS.has(token));
  if (!tokens.length) return [];

  const candidates = [];
  const normalizedOriginal = normalizeTerm(query);
  const add = (value, score) => {
    const term = value.join(' ').trim().slice(0, 96);
    if (!term || normalizeTerm(term) === normalizedOriginal) return;
    const wordCount = term.split(/\s+/).length;
    if (wordCount < 2 && term.length < 5) return;
    candidates.push({ term, score });
  };

  const uniqueTokens = [...new Set(tokens)];
  for (const token of uniqueTokens) {
    add([token], tokenScore(token) + (SCIENTIFIC_SUFFIX.test(token) ? 12 : 0));
  }

  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      const window = tokens.slice(index, index + size);
      add(window, scoreWindow(window) + (size === 3 ? 5 : size === 2 ? 3 : 0));
    }
  }

  add(uniqueTokens.slice(0, 4), scoreWindow(uniqueTokens.slice(0, 4)) + 1);
  add(uniqueTokens.slice(-4), scoreWindow(uniqueTokens.slice(-4)) + 1);
  add(
    [...uniqueTokens]
      .sort((left, right) => tokenScore(right) - tokenScore(left) || uniqueTokens.indexOf(left) - uniqueTokens.indexOf(right))
      .slice(0, 4),
    24
  );

  const seen = new Set();
  const ranked = candidates
    .sort((left, right) => right.score - left.score || left.term.length - right.term.length)
    .filter((candidate) => {
      const normalized = normalizeTerm(candidate.term);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

  const selected = ranked.slice(0, MAX_FALLBACK_QUERIES);
  const strongestSingle = ranked.find((candidate) => !candidate.term.includes(' '));
  if (strongestSingle) {
    const reordered = selected.filter((candidate) => candidate.term !== strongestSingle.term);
    reordered.splice(Math.min(1, reordered.length), 0, strongestSingle);
    return reordered.slice(0, MAX_FALLBACK_QUERIES).map((candidate) => candidate.term);
  }
  return selected.map((candidate) => candidate.term);
}

function tokenize(value) {
  const normalized = normalizeTerm(value);
  return (normalized.match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => token.length >= 3 && token.length <= 32);
}

function meaningfulTokens(value) {
  return [...new Set(tokenize(value).filter((token) => !FALLBACK_STOP_WORDS.has(token)))];
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

function scoreWindow(tokens) {
  return tokens.reduce((total, token) => total + tokenScore(token), 0);
}

function tokenScore(token) {
  let score = Math.min(token.length, 14);
  if (token.length >= 8) score += 3;
  if (SCIENTIFIC_SUFFIX.test(token)) score += 4;
  if (/\d/.test(token)) score += 2;
  return score;
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

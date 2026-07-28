const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_QUERY_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 12_000;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherMediaSearch/1.2 (https://github.com/hatemkhaleefah3-ui/smoking)';
const MEDICAL_VISUAL_TERMS = new Set([
  'heart', 'brain', 'lung', 'lungs', 'kidney', 'kidneys', 'liver', 'stomach',
  'intestine', 'intestines', 'colon', 'pancreas', 'spleen', 'bladder', 'uterus',
  'ovary', 'ovaries', 'prostate', 'eye', 'eyes', 'ear', 'ears', 'skin', 'bone',
  'bones', 'skeleton', 'spine', 'skull', 'muscle', 'muscles', 'artery', 'arteries',
  'vein', 'veins', 'blood', 'neuron', 'neurons', 'nerve', 'nerves', 'cell', 'cells'
]);
const NON_MEDICAL_HINTS = /\b(symbol|emoji|icon|logo|love|valentine|card|band|song|music|album|film|movie|game|tattoo|jewelry|shape)\b/i;

export async function handleMediaSearch(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
  }

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== requestUrl.origin) {
    return json({ error: 'Cross-origin requests are not allowed.' }, 403);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'A JSON request body is required.' }, 400);
  }

  const query = typeof input?.query === 'string' ? input.query.trim().slice(0, MAX_QUERY_LENGTH) : '';
  if (!query) return json({ error: 'Query is required.' }, 400);

  const deterministicTerm = buildDeterministicSearchTerm(query);
  const refinement = await refineSearchTermSafely(query, deterministicTerm, env);

  try {
    let images = await searchWikimediaCommons(refinement.term);

    // Gemini can occasionally produce a phrase that is too narrow. Retry with the
    // deterministic educational query rather than the ambiguous raw input.
    if (images.length === 0 && normalizeTerm(refinement.term) !== normalizeTerm(deterministicTerm)) {
      images = await searchWikimediaCommons(deterministicTerm);
    }

    return json({ images });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'media_search_error',
      stage: error?.stage || 'wikimedia',
      message: error instanceof Error ? error.message : String(error)
    }));
    return json({ error: 'Something went wrong' }, 502);
  }
}

async function refineSearchTermSafely(query, deterministicTerm, env) {
  if (!env?.GEMINI_API_KEY) {
    console.warn(JSON.stringify({
      event: 'media_search_fallback',
      stage: 'configuration',
      message: 'GEMINI_API_KEY is missing; using deterministic educational refinement.'
    }));
    return { term: deterministicTerm, usedGemini: false };
  }

  try {
    const geminiTerm = await refineSearchTerm(query, env);
    return { term: enforceEducationalSpecificity(query, geminiTerm), usedGemini: true };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'media_search_fallback',
      stage: error?.stage || 'gemini',
      message: error instanceof Error ? error.message : String(error)
    }));
    return { term: deterministicTerm, usedGemini: false };
  }
}

async function refineSearchTerm(query, env) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const prompt = [
    'Create one precise English Wikimedia Commons image-search phrase for an educational lecture.',
    'Correct spelling and translate when needed.',
    'Resolve ambiguous short inputs toward the most useful educational visual meaning.',
    'For human organs, anatomy, cells, or body parts, include human/anatomy plus diagram or medical illustration.',
    'Avoid songs, sheet music, quotations, logos, symbols, emojis, and decorative graphics unless the user explicitly asks for them.',
    'Use 5 to 10 concrete keywords likely to appear in Wikimedia file titles or descriptions.',
    'Examples:',
    'Heart -> human heart anatomy diagram medical illustration',
    'Lungs -> human lungs respiratory anatomy diagram medical illustration',
    'Mars -> planet Mars surface photograph NASA',
    'Heart symbol -> red heart symbol icon',
    `User text: ${query}`
  ].join('\n');

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 96,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            searchTerm: {
              type: 'STRING',
              description: 'A precise English Wikimedia Commons image search phrase containing 5 to 10 concrete visual keywords.'
            }
          },
          required: ['searchTerm']
        }
      }
    })
  });

  if (!response.ok) {
    const error = new Error(`Gemini returned ${response.status}.`);
    error.stage = 'gemini';
    throw error;
  }

  const result = await response.json();
  const responseText = (result?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let refinedTerm = '';
  try {
    const structured = JSON.parse(responseText);
    refinedTerm = typeof structured?.searchTerm === 'string' ? structured.searchTerm : '';
  } catch {
    // Retain compatibility if a model ignores the requested JSON schema.
    refinedTerm = responseText;
  }

  refinedTerm = sanitizeSearchTerm(refinedTerm);
  if (!refinedTerm) {
    const error = new Error('Gemini returned an empty search term.');
    error.stage = 'gemini';
    throw error;
  }

  return refinedTerm;
}

function enforceEducationalSpecificity(query, refinedTerm) {
  const cleanTerm = sanitizeSearchTerm(refinedTerm);
  if (!isMedicalVisualQuery(query)) return cleanTerm || buildDeterministicSearchTerm(query);

  const normalized = normalizeTerm(cleanTerm);
  const hasHumanContext = /\b(human|anatomy|anatomical|medical)\b/.test(normalized);
  const hasVisualContext = /\b(diagram|illustration|cross section|medical image|anatomical plate)\b/.test(normalized);
  if (hasHumanContext && hasVisualContext) return cleanTerm;

  return buildDeterministicSearchTerm(query);
}

function buildDeterministicSearchTerm(query) {
  const cleanQuery = sanitizeSearchTerm(query);
  if (!isMedicalVisualQuery(cleanQuery)) return cleanQuery;
  return `human ${normalizeTerm(cleanQuery)} anatomy diagram medical illustration`;
}

function isMedicalVisualQuery(query) {
  if (NON_MEDICAL_HINTS.test(query)) return false;
  const tokens = normalizeTerm(query).split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => MEDICAL_VISUAL_TERMS.has(token));
}

async function searchWikimediaCommons(refinedTerm) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: refinedTerm,
    gsrlimit: '10',
    gsrnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url|mime',
    iiurlwidth: '900',
    format: 'json'
  });
  const endpoint = `https://commons.wikimedia.org/w/api.php?${parameters}`;
  const response = await fetchWithTimeout(endpoint, {
    headers: {
      Accept: 'application/json',
      'User-Agent': WIKIMEDIA_USER_AGENT,
      'Api-User-Agent': WIKIMEDIA_USER_AGENT
    }
  });

  if (!response.ok) {
    const error = new Error(`Wikimedia Commons returned ${response.status}.`);
    error.stage = 'wikimedia';
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error('Wikimedia Commons returned invalid JSON.');
    error.stage = 'wikimedia';
    throw error;
  }

  if (result?.error) {
    const code = typeof result.error.code === 'string' ? result.error.code : 'unknown';
    const error = new Error(`Wikimedia Commons API error: ${code}.`);
    error.stage = 'wikimedia';
    throw error;
  }

  const pages = Object.values(result?.query?.pages || {});
  const images = [];
  const seen = new Set();

  for (const page of pages) {
    const imageInfo = page?.imageinfo?.[0];
    if (!imageInfo || (typeof imageInfo.mime === 'string' && !imageInfo.mime.startsWith('image/'))) continue;
    const value = imageInfo.thumburl || imageInfo.url;
    if (typeof value !== 'string' || seen.has(value)) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') continue;
      seen.add(url.href);
      images.push(url.href);
      if (images.length === 5) break;
    } catch {
      // Ignore malformed Wikimedia entries.
    }
  }

  return images;
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

function sanitizeSearchTerm(value) {
  return String(value || '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function normalizeTerm(value) {
  return sanitizeSearchTerm(value).toLowerCase();
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

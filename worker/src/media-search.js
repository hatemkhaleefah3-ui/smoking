const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_QUERY_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const MAX_IMAGES = 5;
const MAX_CANDIDATES = 12;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherMediaSearch/1.5 (https://github.com/hatemkhaleefah3-ui/smoking)';

export async function handleMediaSearch(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== requestUrl.origin) return json({ error: 'Cross-origin requests are not allowed.' }, 403);

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'A JSON request body is required.' }, 400);
  }

  const query = sanitizeSearchTerm(typeof input?.query === 'string' ? input.query : '');
  if (!query) return json({ error: 'Query is required.' }, 400);

  try {
    if (!env?.GEMINI_API_KEY) {
      console.warn(JSON.stringify({
        event: 'media_search_fallback',
        stage: 'configuration',
        message: 'GEMINI_API_KEY is missing; searching the original user text once.'
      }));
      const candidates = await searchWikimediaCommons(query);
      return json({ images: candidates.slice(0, MAX_IMAGES).map((candidate) => candidate.url) });
    }

    const previousTerms = [];
    const rejectedTitles = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const searchTerm = await generateSearchVariation(query, attempt, previousTerms, rejectedTitles, env);
      if (!searchTerm || previousTerms.some((term) => normalizeTerm(term) === normalizeTerm(searchTerm))) continue;
      previousTerms.push(searchTerm);

      const candidates = await searchWikimediaCommons(searchTerm);
      if (candidates.length === 0) continue;

      const relevantIndexes = await selectRelevantCandidates(query, searchTerm, candidates, env);
      const relevantImages = relevantIndexes
        .map((index) => candidates[index])
        .filter(Boolean)
        .slice(0, MAX_IMAGES)
        .map((candidate) => candidate.url);

      if (relevantImages.length > 0) return json({ images: relevantImages });
      rejectedTitles.push(...candidates.map((candidate) => candidate.title).filter(Boolean));
    }

    return json({ images: [] });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'media_search_error',
      stage: error?.stage || 'unknown',
      message: error instanceof Error ? error.message : String(error)
    }));
    return json({ error: 'Something went wrong' }, 502);
  }
}

async function generateSearchVariation(query, attempt, previousTerms, rejectedTitles, env) {
  const attemptInstruction = {
    1: 'Produce a clean English translation or light refinement of the exact user input. Use the standard academic or technical name when one exists. Do not add a new subject, medium, audience, or interpretation.',
    2: 'Produce a genuinely different synonym, standard academic term, abbreviation expansion, or conventional alternate phrasing for the exact same concept. Do not broaden, narrow, or change the requested visual meaning.',
    3: 'Produce one final alternative phrasing for the exact same concept using another accepted technical term or concise word order. Preserve every explicit constraint and do not drift to a related topic.'
  }[attempt];

  const prompt = [
    'You generate Wikimedia Commons search phrases from user-provided alt text.',
    'Preserve the user’s core intent exactly: subject, process, relationship, requested visual form, population, location, time period, and every explicit constraint.',
    'Never replace the requested concept with a merely related concept. Never invent medical, scientific, historical, decorative, or symbolic intent that the user did not express.',
    'Keep the phrase concise and natural, not a stuffed list of keywords. Prefer 2 to 8 words.',
    attemptInstruction,
    `Original user input: ${query}`,
    previousTerms.length ? `Previously tried phrases that must not be repeated: ${JSON.stringify(previousTerms)}` : '',
    rejectedTitles.length ? `Previous Wikimedia titles were judged irrelevant. Avoid drifting toward these meanings: ${JSON.stringify(rejectedTitles.slice(-12))}` : '',
    'Return only the structured result.'
  ].filter(Boolean).join('\n');

  const result = await callGemini(prompt, {
    type: 'OBJECT',
    properties: {
      searchTerm: {
        type: 'STRING',
        description: 'One concise English Wikimedia search phrase that preserves the exact original intent.'
      },
      intentSummary: {
        type: 'STRING',
        description: 'A short statement of the original concept that the phrase must continue to represent.'
      }
    },
    required: ['searchTerm', 'intentSummary']
  }, env, 96);

  const term = sanitizeSearchTerm(result?.searchTerm);
  if (!term) {
    const error = new Error('Gemini returned an empty search variation.');
    error.stage = 'gemini';
    throw error;
  }
  return term;
}

async function selectRelevantCandidates(query, searchTerm, candidates, env) {
  const titleList = candidates.map((candidate, index) => ({ index, title: candidate.title }));
  const prompt = [
    'You validate Wikimedia Commons search results against the user’s exact alt-text intent.',
    'Select only candidates whose file title depicts the same requested concept or a direct visual representation of it.',
    'Accept standard synonyms and academic terminology.',
    'Reject results that are merely metaphorical, decorative, musical, linguistic, heraldic, symbolic, commercial, or otherwise unrelated unless the user explicitly requested that meaning.',
    'Do not change or broaden the original request while judging relevance.',
    `Original user input: ${query}`,
    `Search phrase used: ${searchTerm}`,
    `Candidate file titles: ${JSON.stringify(titleList)}`,
    'Return the zero-based indexes of relevant candidates only.'
  ].join('\n');

  const result = await callGemini(prompt, {
    type: 'OBJECT',
    properties: {
      relevantIndexes: {
        type: 'ARRAY',
        items: { type: 'INTEGER' },
        description: 'Zero-based indexes of candidates that directly satisfy the original user intent.'
      }
    },
    required: ['relevantIndexes']
  }, env, 96);

  if (!Array.isArray(result?.relevantIndexes)) return [];
  return [...new Set(result.relevantIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < candidates.length)
    .slice(0, MAX_IMAGES);
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
        responseMimeType: 'application/json',
        responseSchema
      }
    })
  });

  if (!response.ok) {
    const error = new Error(`Gemini returned ${response.status}.`);
    error.stage = 'gemini';
    throw error;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error('Gemini returned invalid JSON.');
    error.stage = 'gemini';
    throw error;
  }

  const responseText = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(responseText);
  } catch {
    const error = new Error('Gemini did not return the required structured result.');
    error.stage = 'gemini';
    throw error;
  }
}

async function searchWikimediaCommons(searchTerm) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: searchTerm,
    gsrlimit: String(MAX_CANDIDATES),
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

  const candidates = [];
  const seen = new Set();
  for (const page of Object.values(result?.query?.pages || {})) {
    const imageInfo = page?.imageinfo?.[0];
    if (!imageInfo || (typeof imageInfo.mime === 'string' && !imageInfo.mime.startsWith('image/'))) continue;
    const value = imageInfo.thumburl || imageInfo.url;
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || seen.has(url.href)) continue;
      seen.add(url.href);
      candidates.push({
        url: url.href,
        title: sanitizeFileTitle(page?.title)
      });
      if (candidates.length === MAX_CANDIDATES) break;
    } catch {
      // Ignore malformed Wikimedia entries.
    }
  }
  return candidates;
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

function sanitizeFileTitle(value) {
  return sanitizeSearchTerm(String(value || '').replace(/^File:/i, ''));
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

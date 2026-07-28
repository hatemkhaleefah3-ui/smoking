const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_QUERY_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const MAX_IMAGES = 5;
const MAX_CANDIDATES = 12;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherMediaSearch/1.6 (https://github.com/hatemkhaleefah3-ui/smoking)';
const LOCAL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
  'diagram', 'image', 'illustration', 'photo', 'photograph', 'picture', 'file', 'svg', 'png', 'jpg', 'jpeg'
]);

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

  const previousTerms = [];
  const rejectedTitles = [];
  let geminiAvailable = Boolean(env?.GEMINI_API_KEY);
  let successfulWikimediaCalls = 0;
  let lastWikimediaError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let searchTerm;

    if (geminiAvailable) {
      try {
        searchTerm = await generateSearchVariation(query, attempt, previousTerms, rejectedTitles, env);
      } catch (error) {
        logFallback(error, `Gemini variation ${attempt} failed.`);
        geminiAvailable = false;
        searchTerm = attempt === 1 ? query : '';
      }
    } else {
      searchTerm = attempt === 1 ? query : '';
    }

    if (!searchTerm) break;
    if (previousTerms.some((term) => normalizeTerm(term) === normalizeTerm(searchTerm))) continue;
    previousTerms.push(searchTerm);

    let candidates;
    try {
      candidates = await searchWikimediaCommons(searchTerm);
      successfulWikimediaCalls += 1;
    } catch (error) {
      if (error?.stage !== 'wikimedia') throw error;
      lastWikimediaError = error;
      console.warn(JSON.stringify({
        event: 'media_search_retry',
        stage: 'wikimedia',
        attempt,
        message: error instanceof Error ? error.message : String(error)
      }));
      continue;
    }

    if (candidates.length === 0) continue;

    let relevantIndexes;
    if (geminiAvailable) {
      try {
        relevantIndexes = await selectRelevantCandidates(query, searchTerm, candidates, env);
      } catch (error) {
        logFallback(error, `Gemini relevance check ${attempt} failed.`);
        geminiAvailable = false;
        relevantIndexes = selectRelevantCandidatesLocally(query, searchTerm, candidates);
      }
    } else {
      relevantIndexes = selectRelevantCandidatesLocally(query, searchTerm, candidates);
    }

    const relevantImages = relevantIndexes
      .map((index) => candidates[index])
      .filter(Boolean)
      .slice(0, MAX_IMAGES)
      .map((candidate) => candidate.url);

    if (relevantImages.length > 0) return json({ images: relevantImages });
    rejectedTitles.push(...candidates.map((candidate) => candidate.title).filter(Boolean));
  }

  if (successfulWikimediaCalls === 0 && lastWikimediaError) {
    console.error(JSON.stringify({
      event: 'media_search_error',
      stage: 'wikimedia',
      message: lastWikimediaError instanceof Error ? lastWikimediaError.message : String(lastWikimediaError)
    }));
    return json({ error: 'Something went wrong' }, 502);
  }
  return json({ images: [] });
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
    type: 'object',
    properties: {
      searchTerm: {
        type: 'string',
        description: 'One concise English Wikimedia search phrase that preserves the exact original intent.'
      },
      intentSummary: {
        type: 'string',
        description: 'A short statement of the original concept that the phrase must continue to represent.'
      }
    },
    required: ['searchTerm', 'intentSummary'],
    additionalProperties: false
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
    type: 'object',
    properties: {
      relevantIndexes: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Zero-based indexes of candidates that directly satisfy the original user intent.'
      }
    },
    required: ['relevantIndexes'],
    additionalProperties: false
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
        responseFormat: {
          text: {
            mimeType: 'application/json',
            schema: responseSchema
          }
        }
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

function selectRelevantCandidatesLocally(query, searchTerm, candidates) {
  const tokens = meaningfulTokens(`${query} ${searchTerm}`);
  if (tokens.length === 0) return candidates.slice(0, MAX_IMAGES).map((_, index) => index);

  return candidates
    .map((candidate, index) => {
      const title = normalizeTerm(candidate.title);
      const score = tokens.reduce((total, token) => total + (title.includes(token) ? 1 : 0), 0);
      return { index, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_IMAGES)
    .map((item) => item.index);
}

function meaningfulTokens(value) {
  return [...new Set(normalizeTerm(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !LOCAL_STOP_WORDS.has(token)))];
}

function logFallback(error, message) {
  console.warn(JSON.stringify({
    event: 'media_search_fallback',
    stage: error?.stage || 'gemini',
    message: `${message} ${error instanceof Error ? error.message : String(error)}`
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

const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_QUERY_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 12_000;

export async function handleMediaSearch(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
  }

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== requestUrl.origin) {
    return json({ error: 'Cross-origin requests are not allowed.' }, 403);
  }

  if (!env?.GEMINI_API_KEY) {
    console.error(JSON.stringify({ event: 'media_search_error', stage: 'configuration', message: 'GEMINI_API_KEY is missing.' }));
    return json({ error: 'Something went wrong' }, 500);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'A JSON request body is required.' }, 400);
  }

  const query = typeof input?.query === 'string' ? input.query.trim().slice(0, MAX_QUERY_LENGTH) : '';
  if (!query) return json({ error: 'Query is required.' }, 400);

  try {
    const refinedTerm = await refineSearchTerm(query, env);
    const images = await searchWikimediaCommons(refinedTerm);
    return json({ images });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'media_search_error',
      stage: error?.stage || 'unknown',
      message: error instanceof Error ? error.message : String(error)
    }));
    return json({ error: 'Something went wrong' }, 502);
  }
}

async function refineSearchTerm(query, env) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const prompt = [
    'Turn the user text into one concise English Wikimedia Commons image search phrase.',
    'Correct spelling, translate when needed, preserve important names and concepts, and remove conversational filler.',
    'Return only the search phrase with no explanation, labels, quotation marks, or Markdown.',
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
      generationConfig: { maxOutputTokens: 64 }
    })
  });

  if (!response.ok) {
    const error = new Error(`Gemini returned ${response.status}.`);
    error.stage = 'gemini';
    throw error;
  }

  const result = await response.json();
  const refinedTerm = (result?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);

  if (!refinedTerm) {
    const error = new Error('Gemini returned an empty search term.');
    error.stage = 'gemini';
    throw error;
  }

  return refinedTerm;
}

async function searchWikimediaCommons(refinedTerm) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: refinedTerm,
    gsrlimit: '5',
    gsrnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url',
    format: 'json',
    origin: '*'
  });
  const endpoint = `https://commons.wikimedia.org/w/api.php?${parameters}`;
  const response = await fetchWithTimeout(endpoint, {
    headers: {
      Accept: 'application/json',
      'Api-User-Agent': 'LecturePublisher/1.0 (smart media search)'
    }
  });

  if (!response.ok) {
    const error = new Error(`Wikimedia Commons returned ${response.status}.`);
    error.stage = 'wikimedia';
    throw error;
  }

  const result = await response.json();
  const pages = Object.values(result?.query?.pages || {});
  const images = [];
  const seen = new Set();

  for (const page of pages) {
    const value = page?.imageinfo?.[0]?.url;
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

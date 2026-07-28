const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_QUERY_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_IMAGES = 5;
const MIN_RESULTS_BEFORE_BROADENING = 3;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherMediaSearch/1.4 (https://github.com/hatemkhaleefah3-ui/smoking)';
const VISUAL_TYPES = Object.freeze([
  'labeled anatomical diagram',
  'histology micrograph',
  'microscopy image',
  'biochemical pathway diagram',
  'biological process diagram',
  'molecular structure diagram',
  'chemical reaction scheme',
  'technical schematic',
  'cross-section diagram',
  'block diagram',
  'flowchart',
  'scientific illustration',
  'data graph',
  'geographic map',
  'scientific photograph',
  'archival photograph',
  'geometric diagram'
]);
const VISUAL_TYPE_SET = new Set(VISUAL_TYPES);

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

  const query = typeof input?.query === 'string' ? input.query.trim().slice(0, MAX_QUERY_LENGTH) : '';
  if (!query) return json({ error: 'Query is required.' }, 400);

  const fallbackTerms = buildGenericFallbackTerms(query);
  const terms = await refineSearchTermsSafely(query, fallbackTerms, env);

  try {
    let images = await searchWikimediaCommons(terms.primaryTerm);
    if (images.length < MIN_RESULTS_BEFORE_BROADENING && normalizeTerm(terms.primaryTerm) !== normalizeTerm(terms.broadTerm)) {
      images = mergeImages(images, await searchWikimediaCommons(terms.broadTerm));
    }
    return json({ images: images.slice(0, MAX_IMAGES) });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'media_search_error',
      stage: error?.stage || 'wikimedia',
      message: error instanceof Error ? error.message : String(error)
    }));
    return json({ error: 'Something went wrong' }, 502);
  }
}

async function refineSearchTermsSafely(query, fallbackTerms, env) {
  if (!env?.GEMINI_API_KEY) {
    console.warn(JSON.stringify({
      event: 'media_search_fallback',
      stage: 'configuration',
      message: 'GEMINI_API_KEY is missing; using a concise generic visual query.'
    }));
    return fallbackTerms;
  }

  try {
    return await refineSearchTerms(query, env);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'media_search_fallback',
      stage: error?.stage || 'gemini',
      message: error instanceof Error ? error.message : String(error)
    }));
    return fallbackTerms;
  }
}

async function refineSearchTerms(query, env) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const prompt = [
    'You are an academic visual-search planner for Wikimedia Commons.',
    'Convert the user input into a concise English plan for finding several useful educational images.',
    '',
    'Infer the canonical topic and academic or technical domain, then select the single visual format that best represents it:',
    '- anatomy or macroscopic body structure -> labeled anatomical diagram',
    '- tissue architecture or pathology -> histology micrograph',
    '- cells, microbes, or subcellular structures -> microscopy image',
    '- metabolism, signaling, or enzyme sequences -> biochemical pathway diagram',
    '- biological cycles, mechanisms, or staged processes -> biological process diagram',
    '- molecules or macromolecules -> molecular structure diagram',
    '- chemical transformations -> chemical reaction scheme',
    '- machines, circuits, devices, or engineering systems -> technical schematic, cross-section diagram, or block diagram',
    '- algorithms, software, workflows, or decision logic -> flowchart or block diagram',
    '- quantitative relationships -> data graph',
    '- spatial or geographic topics -> geographic map',
    '- astronomy, field science, specimens, or observable phenomena -> scientific photograph',
    '- historical events or people -> archival photograph when appropriate',
    '- geometry or mathematical constructions -> geometric diagram',
    '- otherwise -> scientific illustration',
    '',
    'Keep the search broad enough for Wikimedia Commons to return multiple files.',
    'Choose zero, one, or at most two short precision qualifiers. Prefer one qualifier.',
    'Each qualifier must be one to three words and must add useful discrimination without repeating the topic, domain, or visual type.',
    'Do not produce long keyword lists. Do not include more than two qualifiers.',
    'Avoid decorative art, logos, quotations, sheet music, plaques, and stock imagery unless explicitly requested.',
    'Do not include commentary or mention Wikimedia Commons.',
    `User input: ${query}`
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
        maxOutputTokens: 128,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            canonicalTopic: {
              type: 'STRING',
              description: 'The concise disambiguated English topic name.'
            },
            domain: {
              type: 'STRING',
              description: 'The academic or technical field used for reasoning. It will not automatically be added to the Wikimedia query.'
            },
            visualType: {
              type: 'STRING',
              enum: VISUAL_TYPES,
              description: 'The single visual format that best communicates this topic.'
            },
            qualifiers: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              maxItems: 2,
              description: 'Zero to two short precision keywords. Prefer one and never return more than two.'
            }
          },
          required: ['canonicalTopic', 'domain', 'visualType', 'qualifiers']
        }
      }
    })
  });

  if (!response.ok) {
    const error = new Error(`Gemini returned ${response.status}.`);
    error.stage = 'gemini';
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error('Gemini returned invalid JSON.');
    error.stage = 'gemini';
    throw error;
  }

  const responseText = (result?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let plan;
  try {
    plan = JSON.parse(responseText);
  } catch {
    const error = new Error('Gemini did not return the required search plan.');
    error.stage = 'gemini';
    throw error;
  }

  return buildSearchTermsFromPlan(plan);
}

function buildSearchTermsFromPlan(plan) {
  const canonicalTopic = sanitizeSearchTerm(plan?.canonicalTopic);
  const domain = sanitizeSearchTerm(plan?.domain);
  const visualType = sanitizeSearchTerm(plan?.visualType);
  const qualifiers = Array.isArray(plan?.qualifiers)
    ? plan.qualifiers.map(sanitizeSearchTerm).filter(Boolean).slice(0, 2)
    : [];

  if (!canonicalTopic || !domain || !VISUAL_TYPE_SET.has(visualType)) {
    const error = new Error('Gemini returned an incomplete or unsupported search plan.');
    error.stage = 'gemini';
    throw error;
  }

  const broadTerm = joinDistinctParts([canonicalTopic, visualType]);
  const usefulQualifiers = qualifiers.filter((qualifier) => {
    const normalized = normalizeTerm(qualifier);
    return normalized && !normalizeTerm(broadTerm).includes(normalized);
  });
  const primaryTerm = joinDistinctParts([canonicalTopic, visualType, ...usefulQualifiers]);

  if (!primaryTerm || normalizeTerm(primaryTerm) === normalizeTerm(canonicalTopic)) {
    const error = new Error('Gemini search plan was not specific enough.');
    error.stage = 'gemini';
    throw error;
  }

  return { primaryTerm, broadTerm };
}

function buildGenericFallbackTerms(query) {
  const cleanQuery = sanitizeSearchTerm(query);
  return {
    primaryTerm: joinDistinctParts([cleanQuery, 'scientific diagram']),
    broadTerm: joinDistinctParts([cleanQuery, 'diagram'])
  };
}

function joinDistinctParts(parts) {
  const output = [];
  const seen = new Set();
  for (const part of parts) {
    const clean = sanitizeSearchTerm(part);
    const normalized = normalizeTerm(clean);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(clean);
  }
  return sanitizeSearchTerm(output.join(' '));
}

function mergeImages(first, second) {
  return [...new Set([...first, ...second])].slice(0, MAX_IMAGES);
}

async function searchWikimediaCommons(refinedTerm) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: refinedTerm,
    gsrlimit: '15',
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
      if (images.length === MAX_IMAGES) break;
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

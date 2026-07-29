const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_CYCLES = 6;
const MIN_ACCEPTED_IMAGES = 5;
const PREFERRED_ACCEPTED_IMAGES = 20;
const MAX_ACCEPTED_IMAGES = 30;
const EXTRA_CYCLES_AFTER_MINIMUM = 2;
const WIKIMEDIA_RESULTS_PER_CYCLE = 20;
const REVIEW_IMAGES_PER_CYCLE = 6;
const ACCEPT_SCORE = 70;
const MAX_IMAGE_BYTES = 1_200_000;
const REQUEST_TIMEOUT_MS = 15_000;
const WIKIMEDIA_USER_AGENT = 'LecturePublisherVisualCycleSearch/1.0 (https://github.com/hatemkhaleefah3-ui/smoking)';

export async function handleVisualCycleMediaSearch(request, env) {
  if (request.method !== 'POST' || !env?.GEMINI_API_KEY) return null;

  let input;
  try {
    input = await request.clone().json();
  } catch {
    return null;
  }

  if (input?.intentSearch !== true || input?.strictRelevance !== true) return null;

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== requestUrl.origin) {
    return Response.json({ error: 'Cross-origin requests are not allowed.' }, { status: 403 });
  }

  const altTexts = normalizeTexts(input?.altTexts, 8, 1200);
  if (altTexts.length === 0) return null;

  const imageId = cleanText(input?.imageId, 160);
  const label = cleanText(input?.label, 240) || imageId || 'Lecture image';

  try {
    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label }, env);
    const grounded = normalizeGroundedBrief(groundedResponse, altTexts, label, imageId);
    const accepted = new Map();
    const seenUrls = new Set();
    const usedQueries = new Set();
    const cycleDetails = [];
    let currentQuery = cleanQuery(grounded.data.firstWikimediaQuery)
      || deterministicQuery(label, imageId, grounded.data.keyConcepts);
    let extraCyclesRemaining = null;
    let stoppedReason = 'maximum-cycles';

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
      currentQuery = ensureUnusedQuery(currentQuery, usedQueries, label, grounded.data.keyConcepts, cycle);
      usedQueries.add(normalize(currentQuery));

      const discovered = await searchWikimedia(currentQuery);
      const unseen = discovered.filter((candidate) => !seenUrls.has(candidate.url));
      unseen.forEach((candidate) => seenUrls.add(candidate.url));
      const reviewable = await loadReviewImages(unseen.slice(0, REVIEW_IMAGES_PER_CYCLE));
      const review = await reviewCycleImages({
        cycle,
        query: currentQuery,
        candidates: reviewable,
        altTexts,
        imageId,
        label,
        visualBrief: grounded.data.visualBrief,
        keyConcepts: grounded.data.keyConcepts,
        expectedVisualFeatures: grounded.data.expectedVisualFeatures,
        acceptedCount: accepted.size,
        usedQueries: [...usedQueries]
      }, env);

      let acceptedThisCycle = 0;
      const rejectedReasons = [];
      for (const decision of review.decisions) {
        const candidate = reviewable[decision.index];
        if (!candidate) continue;
        const score = clampScore(decision.resemblanceScore);
        const resembles = decision.resembles === true && score >= ACCEPT_SCORE;
        if (!resembles) {
          const reason = cleanText(decision.reason, 240);
          if (reason) rejectedReasons.push(reason);
          continue;
        }
        const existing = accepted.get(candidate.url);
        if (!existing || score > existing.resemblanceScore) {
          accepted.set(candidate.url, {
            url: candidate.url,
            title: candidate.title,
            resemblanceScore: score,
            acceptedCycle: cycle,
            acceptedOrder: existing?.acceptedOrder ?? accepted.size
          });
        }
        acceptedThisCycle += 1;
        if (accepted.size >= MAX_ACCEPTED_IMAGES) break;
      }

      cycleDetails.push({
        cycle,
        query: currentQuery,
        discovered: discovered.length,
        visuallyReviewed: reviewable.length,
        accepted: acceptedThisCycle,
        totalAccepted: accepted.size
      });

      if (accepted.size >= MAX_ACCEPTED_IMAGES) {
        stoppedReason = 'maximum-images';
        break;
      }

      if (extraCyclesRemaining === null && accepted.size >= MIN_ACCEPTED_IMAGES) {
        extraCyclesRemaining = EXTRA_CYCLES_AFTER_MINIMUM;
      } else if (extraCyclesRemaining !== null) {
        extraCyclesRemaining -= 1;
      }

      if (extraCyclesRemaining === 0) {
        stoppedReason = 'minimum-plus-two-cycles';
        break;
      }

      if (cycle >= MAX_CYCLES) break;
      currentQuery = cleanQuery(review.nextQuery)
        || fallbackNextQuery({
          label,
          imageId,
          keyConcepts: grounded.data.keyConcepts,
          expectedVisualFeatures: grounded.data.expectedVisualFeatures,
          rejectedReasons,
          cycle
        });
    }

    const ranked = [...accepted.values()]
      .sort((left, right) => (right.resemblanceScore - left.resemblanceScore)
        || (left.acceptedCycle - right.acceptedCycle)
        || (left.acceptedOrder - right.acceptedOrder))
      .slice(0, MAX_ACCEPTED_IMAGES);

    return Response.json({
      images: ranked.map((candidate) => candidate.url),
      usefulCount: ranked.length,
      intentSummary: grounded.data.visualBrief,
      searchRounds: cycleDetails.length,
      targetReached: ranked.length >= MIN_ACCEPTED_IMAGES,
      preferredTargetReached: ranked.length >= PREFERRED_ACCEPTED_IMAGES,
      visualReview: true,
      googleSearchGrounding: grounded.grounding.used,
      groundingQueries: grounded.grounding.queries,
      groundingSources: grounded.grounding.sources,
      searchedQueries: cycleDetails.map((item) => item.query),
      cycles: cycleDetails,
      stoppedReason
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'visual_cycle_search_fallback',
      message: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }
}

async function createGroundedVisualBrief(context, env) {
  const prompt = [
    'Use Google Search grounding before answering.',
    'Research authoritative explanations and representative web images for the scientific or educational subject described below.',
    'All alt texts describe one intended lecture image. Build one accurate visual brief from all of them.',
    'Identify the visual structures, entities, labels, pathways, anatomy, reactions, or relationships that a matching image should visibly contain.',
    'Then create one concise English keyword query suitable for Wikimedia Commons. Do not include site names, URLs, or full sentences in the query.',
    `Visible image label: ${context.label}`,
    `Image id: ${context.imageId || 'not provided'}`,
    `Alt texts: ${JSON.stringify(context.altTexts)}`
  ].join('\n');

  return callGeminiStructured({
    parts: [{ text: prompt }],
    schema: {
      type: 'object',
      properties: {
        visualBrief: { type: 'string' },
        keyConcepts: { type: 'array', items: { type: 'string' } },
        expectedVisualFeatures: { type: 'array', items: { type: 'string' } },
        firstWikimediaQuery: { type: 'string' }
      },
      required: ['visualBrief', 'keyConcepts', 'expectedVisualFeatures', 'firstWikimediaQuery'],
      additionalProperties: false
    },
    env,
    maxOutputTokens: 600,
    googleSearch: true
  });
}

async function reviewCycleImages(context, env) {
  const candidateSummary = context.candidates.map((candidate, index) => ({
    index,
    title: candidate.title,
    description: candidate.description,
    mimeType: candidate.mimeType
  }));
  const parts = [{
    text: [
      'Inspect the actual candidate images attached after this instruction.',
      'All alt texts describe one intended lecture image.',
      'For every candidate, decide whether its visible content genuinely resembles what the alt texts represent.',
      'Reject generic, decorative, merely related, wrong-pathway, wrong-anatomy, wrong-organism, or text-only images.',
      'A candidate is accepted only when the important visible entities, structures, process, or relationship substantially match.',
      'Score resemblance from 0 to 100. Mark resembles=true only for a score of 70 or more.',
      'Create one new concise Wikimedia keyword query that corrects the rejected candidates and searches for missing visual features.',
      'The next query must differ from all prior queries.',
      `Cycle: ${context.cycle} of ${MAX_CYCLES}`,
      `Current Wikimedia query: ${context.query}`,
      `Already accepted images: ${context.acceptedCount}`,
      `Visible image label: ${context.label}`,
      `Image id: ${context.imageId || 'not provided'}`,
      `Alt texts: ${JSON.stringify(context.altTexts)}`,
      `Grounded visual brief: ${context.visualBrief}`,
      `Key concepts: ${JSON.stringify(context.keyConcepts)}`,
      `Expected visible features: ${JSON.stringify(context.expectedVisualFeatures)}`,
      `Queries already used: ${JSON.stringify(context.usedQueries)}`,
      `Candidate index metadata: ${JSON.stringify(candidateSummary)}`
    ].join('\n')
  }];

  for (const candidate of context.candidates) {
    parts.push({ text: `Candidate ${candidate.index}: ${candidate.title}` });
    parts.push({
      inlineData: {
        mimeType: candidate.mimeType,
        data: candidate.base64
      }
    });
  }

  const result = await callGeminiStructured({
    parts,
    schema: {
      type: 'object',
      properties: {
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              resembles: { type: 'boolean' },
              resemblanceScore: { type: 'integer' },
              reason: { type: 'string' }
            },
            required: ['index', 'resembles', 'resemblanceScore', 'reason'],
            additionalProperties: false
          }
        },
        nextQuery: { type: 'string' }
      },
      required: ['decisions', 'nextQuery'],
      additionalProperties: false
    },
    env,
    maxOutputTokens: 900,
    googleSearch: false
  });

  return {
    decisions: normalizeDecisions(result.data?.decisions, context.candidates.length),
    nextQuery: cleanQuery(result.data?.nextQuery)
  };
}

async function searchWikimedia(query) {
  const parameters = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: String(WIKIMEDIA_RESULTS_PER_CYCLE),
    gsrnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiextmetadatafilter: 'ImageDescription|ObjectName',
    iiurlwidth: '512',
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

  const output = [];
  for (const page of Object.values(payload?.query?.pages || {})) {
    const info = page?.imageinfo?.[0];
    if (!info) continue;
    const value = info.thumburl || info.url;
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') continue;
      const metadata = info.extmetadata || {};
      output.push({
        url: url.href,
        title: sanitizeTitle(page?.title),
        description: stripMarkup(metadata.ImageDescription?.value || metadata.ObjectName?.value || '').slice(0, 360),
        mimeType: typeof info.mime === 'string' && info.mime.startsWith('image/') ? info.mime : 'image/jpeg'
      });
    } catch {
      // Ignore malformed image URLs.
    }
  }
  return output;
}

async function loadReviewImages(candidates) {
  const settled = await Promise.allSettled(candidates.map(async (candidate, index) => {
    const response = await fetchWithTimeout(candidate.url, {
      headers: { Accept: 'image/*', 'User-Agent': WIKIMEDIA_USER_AGENT }
    });
    if (!response.ok) throw new Error(`Image returned ${response.status}.`);
    const contentType = (response.headers.get('content-type') || candidate.mimeType || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) throw new Error('Candidate was not an image.');
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_IMAGE_BYTES) throw new Error('Candidate image was too large.');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('Candidate image size was invalid.');
    return {
      ...candidate,
      index,
      mimeType: contentType,
      base64: arrayBufferToBase64(buffer)
    };
  }));
  return settled
    .filter((result) => result.status === 'fulfilled')
    .map((result, index) => ({ ...result.value, index }));
}

async function callGeminiStructured({ parts, schema, env, maxOutputTokens, googleSearch }) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens,
      responseFormat: {
        text: {
          mimeType: 'application/json',
          schema
        }
      }
    }
  };
  if (googleSearch) body.tools = [{ google_search: {} }];

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Gemini returned ${response.status}.`);
  const payload = await response.json();
  const candidate = payload?.candidates?.[0];
  const responseText = (candidate?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join(' ')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error('Gemini did not return the required structured result.');
  }

  return {
    data,
    grounding: extractGrounding(candidate?.groundingMetadata)
  };
}

function normalizeGroundedBrief(result, altTexts, label, imageId) {
  const data = result?.data || {};
  const keyConcepts = normalizeTexts(data.keyConcepts, 12, 180);
  const expectedVisualFeatures = normalizeTexts(data.expectedVisualFeatures, 16, 240);
  return {
    data: {
      visualBrief: cleanText(data.visualBrief, 1000) || altTexts.join(' ').slice(0, 1000),
      keyConcepts: keyConcepts.length ? keyConcepts : normalizeTexts([label, imageId], 4, 180),
      expectedVisualFeatures,
      firstWikimediaQuery: cleanQuery(data.firstWikimediaQuery)
    },
    grounding: result?.grounding || { used: false, queries: [], sources: [] }
  };
}

function extractGrounding(metadata) {
  const queries = normalizeTexts(metadata?.webSearchQueries, 12, 240);
  const sources = [];
  const seen = new Set();
  for (const chunk of metadata?.groundingChunks || []) {
    const title = cleanText(chunk?.web?.title, 180);
    const uri = cleanHttpsUrl(chunk?.web?.uri);
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: title || new URL(uri).hostname, uri });
    if (sources.length >= 12) break;
  }
  return {
    used: queries.length > 0 || sources.length > 0,
    queries,
    sources
  };
}

function normalizeDecisions(values, candidateCount) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const index = Number(value?.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount || seen.has(index)) continue;
    seen.add(index);
    output.push({
      index,
      resembles: value?.resembles === true,
      resemblanceScore: clampScore(value?.resemblanceScore),
      reason: cleanText(value?.reason, 240)
    });
  }
  return output;
}

function ensureUnusedQuery(value, usedQueries, label, keyConcepts, cycle) {
  const candidate = cleanQuery(value);
  if (candidate && !usedQueries.has(normalize(candidate))) return candidate;
  return fallbackNextQuery({ label, imageId: '', keyConcepts, expectedVisualFeatures: [], rejectedReasons: [], cycle });
}

function fallbackNextQuery(context) {
  const pieces = [
    context.label,
    ...context.keyConcepts.slice(context.cycle - 1, context.cycle + 2),
    ...context.expectedVisualFeatures.slice(0, 2),
    ...context.rejectedReasons.slice(0, 1),
    context.imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' ')
  ];
  return cleanQuery(pieces.filter(Boolean).join(' ')).slice(0, 180)
    || `lecture image ${context.cycle}`;
}

function deterministicQuery(label, imageId, keyConcepts) {
  return cleanQuery([label, imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' '), ...keyConcepts.slice(0, 4)].join(' '));
}

function normalizeTexts(values, limit, textLimit) {
  if (!Array.isArray(values)) return [];
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const text = cleanText(value, textLimit);
    const key = normalize(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function cleanQuery(value) {
  return cleanText(value, 240)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—,:;]+|[-–—,:;]+$/g, '')
    .trim();
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
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

function cleanHttpsUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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

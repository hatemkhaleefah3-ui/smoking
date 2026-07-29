const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_CYCLES = 6;
const MIN_ACCEPTED_IMAGES = 5;
const MAX_ACCEPTED_IMAGES = 30;
const EXTRA_CYCLES_AFTER_MINIMUM = 2;
const RESULTS_PER_SOURCE = 20;
const REVIEW_IMAGES_PER_CYCLE = 4;
const ACCEPT_SCORE = 70;
const MAX_IMAGE_BYTES = 1_200_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = 'LecturePublisherMultiSourceSearch/2.0 (https://github.com/hatemkhaleefah3-ui/smoking)';
const SOURCE_ORDER = ['Wikimedia Commons', 'Openverse', 'Wellcome Collection'];
const OPENVERSE_LICENSES = ['cc0', 'pdm', 'by', 'by-sa', 'by-nc', 'by-nc-sa'];

export async function handleMultiSourceMediaSearchV2(request, env) {
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
  if (!altTexts.length) return null;
  const imageId = cleanText(input?.imageId, 160);
  const label = cleanText(input?.label, 240) || imageId || 'Lecture image';

  try {
    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label }, env);
    const grounded = normalizeGroundedBrief(groundedResponse, altTexts, label, imageId);
    const accepted = new Map();
    const successfullyReviewed = new Set();
    const usedQueries = new Set();
    const cycles = [];
    const providerDiagnostics = createProviderDiagnostics();
    let query = cleanQuery(grounded.data.firstSearchQuery)
      || deterministicQuery(label, imageId, grounded.data.keyConcepts);
    let extraCyclesRemaining = null;
    let stoppedReason = 'maximum-cycles';

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
      query = ensureUnusedQuery(query, usedQueries, label, grounded.data.keyConcepts, cycle);
      usedQueries.add(normalize(query));

      const discovery = await discoverAllSources(query);
      mergeProviderDiagnostics(providerDiagnostics, discovery.providers);
      const selected = chooseBalancedCandidates(discovery.candidates, successfullyReviewed, REVIEW_IMAGES_PER_CYCLE);
      const loadedResult = await loadReviewImages(selected);
      for (const candidate of loadedResult.loaded) {
        successfullyReviewed.add(canonicalCandidateKey(candidate));
        providerDiagnostics[candidate.source].loaded += 1;
      }
      for (const failure of loadedResult.failures) {
        providerDiagnostics[failure.source].imageErrors += 1;
        providerDiagnostics[failure.source].lastImageError = failure.message;
      }

      if (!loadedResult.loaded.length) {
        cycles.push({
          cycle,
          query,
          discovered: discovery.candidates.length,
          visuallyReviewed: 0,
          accepted: 0,
          totalAccepted: accepted.size,
          sources: countSources(discovery.candidates),
          providerStatus: discovery.providers
        });
        query = fallbackNextQuery({
          label,
          imageId,
          keyConcepts: grounded.data.keyConcepts,
          expectedVisualFeatures: grounded.data.expectedVisualFeatures,
          rejectedReasons: loadedResult.failures.map((item) => item.message),
          cycle
        });
        continue;
      }

      const review = await reviewCycleImages({
        cycle,
        query,
        candidates: loadedResult.loaded,
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
        const candidate = loadedResult.loaded[decision.index];
        if (!candidate) continue;
        const score = clampScore(decision.resemblanceScore);
        if (decision.resembles !== true || score < ACCEPT_SCORE) {
          const reason = cleanText(decision.reason, 240);
          if (reason) rejectedReasons.push(reason);
          continue;
        }
        const key = canonicalCandidateKey(candidate);
        const existing = accepted.get(key);
        if (!existing || score > existing.resemblanceScore) {
          accepted.set(key, {
            ...stripReviewData(candidate),
            resemblanceScore: score,
            acceptedCycle: cycle,
            acceptedOrder: existing?.acceptedOrder ?? accepted.size
          });
        }
        acceptedThisCycle += 1;
        providerDiagnostics[candidate.source].accepted += 1;
        if (accepted.size >= MAX_ACCEPTED_IMAGES) break;
      }

      cycles.push({
        cycle,
        query,
        discovered: discovery.candidates.length,
        visuallyReviewed: loadedResult.loaded.length,
        accepted: acceptedThisCycle,
        totalAccepted: accepted.size,
        sources: countSources(discovery.candidates),
        providerStatus: discovery.providers
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
      query = cleanQuery(review.nextQuery) || fallbackNextQuery({
        label,
        imageId,
        keyConcepts: grounded.data.keyConcepts,
        expectedVisualFeatures: grounded.data.expectedVisualFeatures,
        rejectedReasons,
        cycle
      });
    }

    const ranked = [...accepted.values()]
      .sort((a, b) => (b.resemblanceScore - a.resemblanceScore)
        || (a.acceptedCycle - b.acceptedCycle)
        || (a.acceptedOrder - b.acceptedOrder))
      .slice(0, MAX_ACCEPTED_IMAGES);
    const imageResults = ranked.map(publicResult);

    return Response.json({
      images: imageResults.map((item) => item.url),
      imageResults,
      usefulCount: imageResults.length,
      intentSummary: grounded.data.visualBrief,
      searchRounds: cycles.length,
      targetReached: imageResults.length >= MIN_ACCEPTED_IMAGES,
      visualReview: true,
      multiSource: true,
      engine: 'multi-source-v2',
      allowedLicenses: ['CC0', 'Public Domain', 'CC BY', 'CC BY-SA', 'CC BY-NC', 'CC BY-NC-SA'],
      googleSearchGrounding: grounded.grounding.used,
      groundingQueries: grounded.grounding.queries,
      groundingSources: grounded.grounding.sources,
      searchedQueries: cycles.map((item) => item.query),
      sourceCounts: countSources(ranked),
      providerDiagnostics,
      cycles,
      stoppedReason
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'multisource_v2_fallback',
      message: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }
}

async function discoverAllSources(query) {
  const jobs = [
    ['Wikimedia Commons', () => searchWikimedia(query)],
    ['Openverse', () => searchOpenverse(query)],
    ['Wellcome Collection', () => searchWellcome(query)]
  ];
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  const candidates = [];
  const providers = {};
  settled.forEach((result, index) => {
    const source = jobs[index][0];
    if (result.status === 'fulfilled') {
      candidates.push(...result.value);
      providers[source] = { ok: true, found: result.value.length, error: '' };
    } else {
      providers[source] = {
        ok: false,
        found: 0,
        error: cleanText(result.reason instanceof Error ? result.reason.message : String(result.reason), 240)
      };
    }
  });
  return { candidates, providers };
}

async function searchWikimedia(query) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: String(RESULTS_PER_SOURCE),
    gsrnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiextmetadatafilter: 'ImageDescription|ObjectName|Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms',
    iiurlwidth: '512',
    format: 'json'
  });
  const response = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: apiHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}.`);
  const payload = await response.json();
  if (payload?.error) throw new Error(`Wikimedia Commons API error: ${payload.error.code || 'unknown'}.`);

  const output = [];
  for (const page of Object.values(payload?.query?.pages || {})) {
    const info = page?.imageinfo?.[0];
    const previewUrl = cleanHttpsUrl(info?.thumburl || info?.url);
    const originalUrl = cleanHttpsUrl(info?.url);
    if (!previewUrl) continue;
    const metadata = info.extmetadata || {};
    const title = sanitizeTitle(page?.title);
    const creator = stripMarkup(metadata.Artist?.value || metadata.Credit?.value || '');
    const license = stripMarkup(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || 'See source page');
    output.push({
      url: previewUrl,
      reviewUrls: uniqueUrls([previewUrl, originalUrl]),
      originalUrl,
      source: 'Wikimedia Commons',
      title,
      description: stripMarkup(metadata.ImageDescription?.value || metadata.ObjectName?.value || '').slice(0, 360),
      creator,
      creatorUrl: '',
      license,
      licenseUrl: cleanHttpsUrl(metadata.LicenseUrl?.value),
      attribution: [title, creator, license].filter(Boolean).join(' — '),
      sourcePage: page?.pageid ? `https://commons.wikimedia.org/?curid=${page.pageid}` : '',
      mimeType: normalizeMime(info?.mime)
    });
  }
  return output;
}

async function searchOpenverse(query) {
  const params = new URLSearchParams({
    q: query,
    license: OPENVERSE_LICENSES.join(','),
    excluded_source: 'wikimedia',
    page_size: String(RESULTS_PER_SOURCE),
    mature: 'false'
  });
  const response = await fetchWithTimeout(`https://api.openverse.org/v1/images/?${params}`, {
    headers: apiHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Openverse returned ${response.status}.`);
  const payload = await response.json();
  const output = [];
  for (const item of payload?.results || []) {
    const licenseCode = normalize(item?.license).replace(/ /g, '-');
    if (!OPENVERSE_LICENSES.includes(licenseCode)) continue;
    const previewUrl = cleanHttpsUrl(item?.thumbnail);
    const originalUrl = cleanHttpsUrl(item?.url);
    const displayUrl = previewUrl || originalUrl;
    if (!displayUrl) continue;
    const license = formatOpenverseLicense(item?.license, item?.license_version);
    output.push({
      url: displayUrl,
      reviewUrls: uniqueUrls([previewUrl, originalUrl]),
      originalUrl,
      source: 'Openverse',
      title: cleanText(item?.title, 240) || 'Untitled image',
      description: normalizeTags(item?.tags).slice(0, 360),
      creator: cleanText(item?.creator, 200),
      creatorUrl: cleanHttpsUrl(item?.creator_url),
      license,
      licenseUrl: cleanHttpsUrl(item?.license_url) || licenseUrlFor(license),
      attribution: cleanText(item?.attribution, 600) || buildAttribution(item?.title, item?.creator, license),
      sourcePage: cleanHttpsUrl(item?.foreign_landing_url || item?.detail_url),
      mimeType: normalizeMimeFromUrl(displayUrl)
    });
  }
  return output;
}

async function searchWellcome(query) {
  const params = new URLSearchParams({
    query,
    pageSize: String(RESULTS_PER_SOURCE),
    include: 'source.contributors,source.subjects,source.genres'
  });
  const response = await fetchWithTimeout(`https://api.wellcomecollection.org/catalogue/v2/images?${params}`, {
    headers: apiHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Wellcome Collection returned ${response.status}.`);
  const payload = await response.json();
  const output = [];
  for (const item of payload?.results || []) {
    const location = chooseWellcomeLocation(item);
    const infoUrl = cleanHttpsUrl(location?.url || item?.thumbnail?.url);
    const imageUrl = wellcomeIiifImageUrl(infoUrl);
    const licenseInfo = normalizeWellcomeLicense(location?.license || item?.thumbnail?.license);
    if (!imageUrl || !licenseInfo.allowed) continue;
    const creator = extractWellcomeCreator(item?.source?.contributors);
    const title = cleanText(item?.source?.title, 260) || `Wellcome image ${cleanText(item?.id, 80)}`;
    output.push({
      url: imageUrl,
      reviewUrls: [imageUrl],
      originalUrl: imageUrl,
      source: 'Wellcome Collection',
      title,
      description: wellcomeDescription(item),
      creator,
      creatorUrl: '',
      license: licenseInfo.label,
      licenseUrl: licenseInfo.url,
      attribution: cleanText(location?.credit || item?.thumbnail?.credit, 600)
        || buildAttribution(title, creator || 'Wellcome Collection', licenseInfo.label),
      sourcePage: item?.source?.id ? `https://wellcomecollection.org/works/${encodeURIComponent(item.source.id)}` : '',
      mimeType: 'image/jpeg'
    });
  }
  return output;
}

function chooseWellcomeLocation(item) {
  const values = [item?.thumbnail, ...(Array.isArray(item?.locations) ? item.locations : [])].filter(Boolean);
  return values.find((location) => {
    const url = wellcomeIiifImageUrl(cleanHttpsUrl(location?.url));
    return Boolean(url) && normalizeWellcomeLicense(location?.license).allowed;
  }) || null;
}

function wellcomeIiifImageUrl(value) {
  const url = cleanHttpsUrl(value);
  if (!url) return '';
  if (/\/info\.json(?:\?.*)?$/i.test(url)) {
    return url.replace(/\/info\.json(?:\?.*)?$/i, '/full/!512,512/0/default.jpg');
  }
  return url;
}

function normalizeWellcomeLicense(value) {
  const id = cleanText(value?.id, 80);
  const label = cleanText(value?.label, 160) || id;
  const normalized = normalize(`${id} ${label}`).replace(/ /g, '-');
  if (!normalized || /(^|-)nd($|-)|no-derivatives|in-copyright|rights-reserved|unknown|restricted/.test(normalized)) {
    return { allowed: false, label, url: '' };
  }
  const allowed = /cc0|public-domain|pdm|cc-by-nc-sa|cc-by-nc|cc-by-sa|cc-by/.test(normalized);
  return {
    allowed,
    label: canonicalLicenseLabel(label || id),
    url: cleanHttpsUrl(value?.url) || licenseUrlFor(label || id)
  };
}

function chooseBalancedCandidates(candidates, reviewed, limit) {
  const groups = new Map(SOURCE_ORDER.map((source) => [source, []]));
  for (const candidate of candidates) {
    const key = canonicalCandidateKey(candidate);
    if (!key || reviewed.has(key)) continue;
    if (!groups.has(candidate.source)) groups.set(candidate.source, []);
    groups.get(candidate.source).push(candidate);
  }
  const selected = [];
  const selectedKeys = new Set();
  while (selected.length < limit) {
    let added = false;
    for (const source of SOURCE_ORDER) {
      const group = groups.get(source) || [];
      while (group.length) {
        const candidate = group.shift();
        const key = canonicalCandidateKey(candidate);
        if (!key || selectedKeys.has(key)) continue;
        selectedKeys.add(key);
        selected.push(candidate);
        added = true;
        break;
      }
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

async function loadReviewImages(candidates) {
  const settled = await Promise.allSettled(candidates.map(async (candidate) => {
    const attempts = uniqueUrls(candidate.reviewUrls?.length ? candidate.reviewUrls : [candidate.url]);
    let lastError = 'No usable image URL.';
    for (const url of attempts) {
      try {
        const response = await fetchWithTimeout(url, { headers: { Accept: 'image/*' } });
        if (!response.ok) throw new Error(`Image returned ${response.status}.`);
        const contentType = (response.headers.get('content-type') || candidate.mimeType || '').split(';')[0].trim();
        if (!contentType.startsWith('image/')) throw new Error(`Candidate returned ${contentType || 'an unknown type'}, not an image.`);
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > MAX_IMAGE_BYTES) throw new Error('Candidate image was too large.');
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('Candidate image size was invalid.');
        return {
          ...candidate,
          url,
          mimeType: contentType,
          base64: arrayBufferToBase64(buffer)
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw Object.assign(new Error(lastError), { source: candidate.source });
  }));

  const loaded = [];
  const failures = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === 'fulfilled') {
      loaded.push({ ...result.value, index: loaded.length });
    } else {
      failures.push({
        source: candidates[index]?.source || 'Unknown',
        message: cleanText(result.reason instanceof Error ? result.reason.message : String(result.reason), 240)
      });
    }
  }
  return { loaded, failures };
}

async function createGroundedVisualBrief(context, env) {
  const prompt = [
    'Use Google Search grounding before answering.',
    'Research authoritative explanations and representative web images for the scientific or educational subject below.',
    'All alt texts describe one intended lecture image. Build one accurate visual brief from all of them.',
    'Identify visible structures, entities, labels, pathways, anatomy, reactions, or relationships that a matching image should contain.',
    'Create one concise English keyword query suitable for Wikimedia Commons, Openverse, and Wellcome Collection.',
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
        firstSearchQuery: { type: 'string' }
      },
      required: ['visualBrief', 'keyConcepts', 'expectedVisualFeatures', 'firstSearchQuery'],
      additionalProperties: false
    },
    env,
    maxOutputTokens: 600,
    googleSearch: true
  });
}

async function reviewCycleImages(context, env) {
  const summary = context.candidates.map((candidate, index) => ({
    index,
    source: candidate.source,
    title: candidate.title,
    description: candidate.description,
    license: candidate.license
  }));
  const parts = [{
    text: [
      'Inspect the actual candidate images attached after this instruction.',
      'All alt texts describe one intended lecture image.',
      'For every candidate, decide whether its visible content genuinely resembles what the alt texts represent.',
      'Reject generic, decorative, merely related, wrong-pathway, wrong-anatomy, wrong-organism, or text-only images.',
      'Score resemblance from 0 to 100. Mark resembles=true only for a score of 70 or more.',
      'Create one new concise query for Wikimedia Commons, Openverse, and Wellcome Collection that corrects rejected candidates.',
      'The next query must differ from all prior queries.',
      `Cycle: ${context.cycle} of ${MAX_CYCLES}`,
      `Current query: ${context.query}`,
      `Already accepted images: ${context.acceptedCount}`,
      `Visible image label: ${context.label}`,
      `Image id: ${context.imageId || 'not provided'}`,
      `Alt texts: ${JSON.stringify(context.altTexts)}`,
      `Grounded visual brief: ${context.visualBrief}`,
      `Key concepts: ${JSON.stringify(context.keyConcepts)}`,
      `Expected visible features: ${JSON.stringify(context.expectedVisualFeatures)}`,
      `Queries already used: ${JSON.stringify(context.usedQueries)}`,
      `Candidate metadata: ${JSON.stringify(summary)}`
    ].join('\n')
  }];
  for (const candidate of context.candidates) {
    parts.push({ text: `Candidate ${candidate.index}: ${candidate.source} — ${candidate.title}` });
    parts.push({ inlineData: { mimeType: candidate.mimeType, data: candidate.base64 } });
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

async function callGeminiStructured({ parts, schema, env, maxOutputTokens, googleSearch }) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens,
      responseFormat: { text: { mimeType: 'application/json', schema } }
    }
  };
  if (googleSearch) body.tools = [{ google_search: {} }];
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
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
  return { data, grounding: extractGrounding(candidate?.groundingMetadata) };
}

function normalizeGroundedBrief(result, altTexts, label, imageId) {
  const data = result?.data || {};
  const keyConcepts = normalizeTexts(data.keyConcepts, 12, 180);
  return {
    data: {
      visualBrief: cleanText(data.visualBrief, 1000) || altTexts.join(' ').slice(0, 1000),
      keyConcepts: keyConcepts.length ? keyConcepts : normalizeTexts([label, imageId], 4, 180),
      expectedVisualFeatures: normalizeTexts(data.expectedVisualFeatures, 16, 240),
      firstSearchQuery: cleanQuery(data.firstSearchQuery)
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
  return { used: queries.length > 0 || sources.length > 0, queries, sources };
}

function createProviderDiagnostics() {
  return Object.fromEntries(SOURCE_ORDER.map((source) => [source, {
    searchCalls: 0,
    found: 0,
    loaded: 0,
    accepted: 0,
    searchErrors: 0,
    imageErrors: 0,
    lastSearchError: '',
    lastImageError: ''
  }]));
}

function mergeProviderDiagnostics(target, providers) {
  for (const source of SOURCE_ORDER) {
    const status = providers[source] || { ok: false, found: 0, error: 'Provider did not report a status.' };
    target[source].searchCalls += 1;
    target[source].found += Number(status.found) || 0;
    if (!status.ok) {
      target[source].searchErrors += 1;
      target[source].lastSearchError = cleanText(status.error, 240);
    }
  }
}

function countSources(candidates) {
  const counts = {};
  for (const candidate of candidates) {
    const source = candidate.source || 'Unknown';
    counts[source] = (counts[source] || 0) + 1;
  }
  return counts;
}

function stripReviewData(candidate) {
  const { base64, reviewUrls, index, ...output } = candidate;
  return output;
}

function publicResult(candidate) {
  return {
    url: candidate.url,
    originalUrl: candidate.originalUrl,
    source: candidate.source,
    title: candidate.title,
    creator: candidate.creator,
    creatorUrl: candidate.creatorUrl,
    license: candidate.license,
    licenseUrl: candidate.licenseUrl,
    attribution: candidate.attribution,
    sourcePage: candidate.sourcePage,
    resemblanceScore: candidate.resemblanceScore
  };
}

function canonicalCandidateKey(candidate) {
  return cleanHttpsUrl(candidate?.originalUrl) || cleanHttpsUrl(candidate?.url);
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
  return cleanQuery([
    context.label,
    ...context.keyConcepts.slice(context.cycle - 1, context.cycle + 2),
    ...context.expectedVisualFeatures.slice(0, 2),
    ...context.rejectedReasons.slice(0, 1),
    context.imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' ')
  ].filter(Boolean).join(' ')).slice(0, 180) || `lecture image ${context.cycle}`;
}

function deterministicQuery(label, imageId, keyConcepts) {
  return cleanQuery([label, imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' '), ...keyConcepts.slice(0, 4)].join(' '));
}

function extractWellcomeCreator(values) {
  if (!Array.isArray(values)) return '';
  return values.map((item) => cleanText(item?.agent?.label || item?.label, 160)).filter(Boolean).slice(0, 3).join(', ');
}

function wellcomeDescription(item) {
  const subjects = (item?.source?.subjects || []).map((value) => value?.label).filter(Boolean);
  const genres = (item?.source?.genres || []).map((value) => value?.label).filter(Boolean);
  return cleanText([item?.source?.description, item?.source?.lettering, ...subjects, ...genres].filter(Boolean).join(' · '), 360);
}

function normalizeTags(values) {
  if (!Array.isArray(values)) return '';
  return values.map((item) => cleanText(item?.name || item, 80)).filter(Boolean).slice(0, 20).join(', ');
}

function formatOpenverseLicense(value, version) {
  const code = normalize(value).replace(/ /g, '-');
  const labels = {
    cc0: 'CC0', pdm: 'Public Domain Mark', by: 'CC BY', 'by-sa': 'CC BY-SA',
    'by-nc': 'CC BY-NC', 'by-nc-sa': 'CC BY-NC-SA'
  };
  return `${labels[code] || cleanText(value, 80)}${cleanText(version, 20) ? ` ${cleanText(version, 20)}` : ''}`.trim();
}

function canonicalLicenseLabel(value) {
  const normalized = normalize(value).replace(/ /g, '-');
  if (/cc0/.test(normalized)) return 'CC0';
  if (/public-domain|pdm/.test(normalized)) return 'Public Domain';
  if (/cc-by-nc-sa/.test(normalized)) return 'CC BY-NC-SA';
  if (/cc-by-nc/.test(normalized)) return 'CC BY-NC';
  if (/cc-by-sa/.test(normalized)) return 'CC BY-SA';
  if (/cc-by/.test(normalized)) return 'CC BY';
  return cleanText(value, 160);
}

function licenseUrlFor(value) {
  const normalized = normalize(value).replace(/ /g, '-');
  if (/cc0/.test(normalized)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (/public-domain|pdm/.test(normalized)) return 'https://creativecommons.org/publicdomain/mark/1.0/';
  if (/cc-by-nc-sa/.test(normalized)) return 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
  if (/cc-by-nc/.test(normalized)) return 'https://creativecommons.org/licenses/by-nc/4.0/';
  if (/cc-by-sa/.test(normalized)) return 'https://creativecommons.org/licenses/by-sa/4.0/';
  if (/cc-by/.test(normalized)) return 'https://creativecommons.org/licenses/by/4.0/';
  return '';
}

function buildAttribution(title, creator, license) {
  return [cleanText(title, 240) || 'Untitled image', cleanText(creator, 200), cleanText(license, 120)].filter(Boolean).join(' — ');
}

function apiHeaders(accept) {
  return { Accept: accept, 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT };
}

function normalizeMime(value) {
  return typeof value === 'string' && value.startsWith('image/') ? value : 'image/jpeg';
}

function normalizeMimeFromUrl(value) {
  const path = String(value || '').split('?')[0].toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
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

function uniqueUrls(values) {
  return [...new Set((values || []).map(cleanHttpsUrl).filter(Boolean))];
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
  return String(value || '').replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
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

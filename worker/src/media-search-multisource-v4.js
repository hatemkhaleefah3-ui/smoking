const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_CYCLES = 6;
const MIN_ACCEPTED_IMAGES = 5;
const MAX_ACCEPTED_IMAGES = 30;
const EXTRA_CYCLES_AFTER_MINIMUM = 2;
const RESULTS_PER_SOURCE = 20;
const REVIEW_IMAGES_PER_CYCLE = 3;
const MAX_LOAD_ATTEMPTS_PER_SOURCE = 3;
const ACCEPT_SCORE = 82;
const MIN_VISUAL_COVERAGE = 75;
const MAX_IMAGE_BYTES = 2_500_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = 'LecturePublisherMultiSourceSearch/4.0 (https://github.com/hatemkhaleefah3-ui/smoking)';
const SOURCE_ORDER = ['Wikimedia Commons', 'Openverse', 'Wellcome Collection'];
const OPENVERSE_LICENSES = ['cc0', 'pdm', 'by', 'by-sa', 'by-nc', 'by-nc-sa'];

export async function handleMultiSourceMediaSearchV4(request, env) {
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
  const searchRun = normalizeSearchRun(input?.searchRun);
  const resultPage = 1 + (searchRun % 5);
  const excludedUrls = new Set(normalizeExcludedUrls(input?.excludedUrls));

  try {
    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label, searchRun }, env);
    const grounded = normalizeGroundedBrief(groundedResponse, altTexts, label, imageId);
    const accepted = new Map();
    const attempted = new Set();
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

      const discovery = await discoverAllSources(query, resultPage);
      mergeProviderDiagnostics(providerDiagnostics, discovery.providers);
      const sourceOrder = rotatedSourceOrder(cycle, searchRun);
      const loadedResult = await loadBalancedReviewImages({
        candidates: discovery.candidates,
        attempted,
        excludedUrls,
        sourceOrder,
        providerDiagnostics
      });

      if (!loadedResult.loaded.length) {
        cycles.push({
          cycle,
          query,
          resultPage,
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
      const requiredEvidenceCount = grounded.data.expectedVisualFeatures.length >= 2 ? 2 : 1;

      for (const decision of review.decisions) {
        const candidate = loadedResult.loaded[decision.index];
        if (!candidate) continue;
        providerDiagnostics[candidate.source].reviewed += 1;

        if (!meetsStrictAcceptance(decision, requiredEvidenceCount)) {
          providerDiagnostics[candidate.source].rejected += 1;
          const reason = cleanText(decision.reason, 300);
          if (reason) rejectedReasons.push(reason);
          continue;
        }

        const key = canonicalCandidateKey(candidate);
        const existing = accepted.get(key);
        const result = {
          ...stripReviewData(candidate),
          resemblanceScore: decision.resemblanceScore,
          visualCoverage: decision.visualCoverage,
          matchedFeatures: decision.matchedFeatures,
          acceptanceReason: decision.reason,
          acceptedCycle: cycle,
          acceptedOrder: existing?.acceptedOrder ?? accepted.size
        };
        if (!existing || result.resemblanceScore > existing.resemblanceScore) {
          accepted.set(key, result);
        }
        if (!existing) {
          acceptedThisCycle += 1;
          providerDiagnostics[candidate.source].accepted += 1;
        }
        if (accepted.size >= MAX_ACCEPTED_IMAGES) break;
      }

      cycles.push({
        cycle,
        query,
        resultPage,
        discovered: discovery.candidates.length,
        visuallyReviewed: loadedResult.loaded.length,
        reviewedSources: countSources(loadedResult.loaded),
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
        || (b.visualCoverage - a.visualCoverage)
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
      engine: 'multi-source-v4',
      searchRun,
      resultPage,
      excludedPrevious: excludedUrls.size,
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
      event: 'multisource_v4_fallback',
      message: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }
}

async function discoverAllSources(query, page) {
  const jobs = [
    ['Wikimedia Commons', () => searchWikimedia(query, page)],
    ['Openverse', () => searchOpenverse(query, page)],
    ['Wellcome Collection', () => searchWellcome(query, page)]
  ];
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  const candidates = [];
  const providers = {};

  settled.forEach((result, index) => {
    const source = jobs[index][0];
    if (result.status === 'fulfilled') {
      candidates.push(...result.value.candidates);
      providers[source] = {
        ok: true,
        rawFound: result.value.rawCount,
        eligibleFound: result.value.candidates.length,
        error: ''
      };
    } else {
      providers[source] = {
        ok: false,
        rawFound: 0,
        eligibleFound: 0,
        error: cleanText(result.reason instanceof Error ? result.reason.message : String(result.reason), 300)
      };
    }
  });

  return { candidates, providers };
}

async function searchWikimedia(query, page) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: String(RESULTS_PER_SOURCE),
    gsroffset: String((Math.max(1, page) - 1) * RESULTS_PER_SOURCE),
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

  const pages = Object.values(payload?.query?.pages || {});
  const candidates = [];
  for (const pageItem of pages) {
    const info = pageItem?.imageinfo?.[0];
    const previewUrl = cleanHttpsUrl(info?.thumburl || info?.url);
    const originalUrl = cleanHttpsUrl(info?.url);
    if (!previewUrl) continue;
    const metadata = info.extmetadata || {};
    const title = sanitizeTitle(pageItem?.title);
    const creator = stripMarkup(metadata.Artist?.value || metadata.Credit?.value || '');
    const license = stripMarkup(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || 'See source page');
    candidates.push({
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
      sourcePage: pageItem?.pageid ? `https://commons.wikimedia.org/?curid=${pageItem.pageid}` : '',
      mimeType: normalizeMime(info?.mime)
    });
  }
  return { rawCount: pages.length, candidates };
}

async function searchOpenverse(query, page) {
  const params = new URLSearchParams({
    q: query,
    license: OPENVERSE_LICENSES.join(','),
    excluded_source: 'wikimedia',
    page_size: String(RESULTS_PER_SOURCE),
    page: String(Math.max(1, page)),
    mature: 'false'
  });
  const response = await fetchWithTimeout(`https://api.openverse.org/v1/images/?${params}`, {
    headers: apiHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Openverse returned ${response.status}.`);
  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const candidates = [];

  for (const item of results) {
    const licenseCode = normalize(item?.license).replace(/ /g, '-');
    if (!OPENVERSE_LICENSES.includes(licenseCode)) continue;
    const previewUrl = cleanHttpsUrl(item?.thumbnail);
    const originalUrl = cleanHttpsUrl(item?.url);
    const displayUrl = previewUrl || originalUrl;
    if (!displayUrl) continue;
    const license = formatOpenverseLicense(item?.license, item?.license_version);
    candidates.push({
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

  return { rawCount: results.length, candidates };
}

async function searchWellcome(query, page) {
  const params = new URLSearchParams({
    query,
    pageSize: String(RESULTS_PER_SOURCE),
    page: String(Math.max(1, page)),
    include: 'source.contributors,source.subjects,source.genres,source.locations'
  });
  const response = await fetchWithTimeout(`https://api.wellcomecollection.org/catalogue/v2/images?${params}`, {
    headers: apiHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Wellcome Collection returned ${response.status}.`);
  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const candidates = [];

  for (const item of results) {
    const location = chooseWellcomeLocation(item);
    if (!location) continue;
    const imageUrl = wellcomeIiifImageUrl(cleanHttpsUrl(location.url));
    const licenseInfo = normalizeWellcomeLicense(
      location.license || item?.license || item?.thumbnail?.license || item?.source?.license
    );
    if (!imageUrl || !licenseInfo.allowed) continue;
    const creator = extractWellcomeCreator(item?.source?.contributors);
    const title = cleanText(item?.source?.title || item?.title, 260)
      || `Wellcome image ${cleanText(item?.id, 80)}`;
    candidates.push({
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
      attribution: cleanText(location?.credit || item?.thumbnail?.credit || item?.credit, 600)
        || buildAttribution(title, creator || 'Wellcome Collection', licenseInfo.label),
      sourcePage: item?.source?.id
        ? `https://wellcomecollection.org/works/${encodeURIComponent(item.source.id)}`
        : cleanHttpsUrl(item?.sourcePage),
      mimeType: 'image/jpeg'
    });
  }

  return { rawCount: results.length, candidates };
}

function chooseWellcomeLocation(item) {
  const values = [
    item?.thumbnail,
    ...(Array.isArray(item?.locations) ? item.locations : []),
    ...(Array.isArray(item?.source?.locations) ? item.source.locations : [])
  ].filter(Boolean);

  return values.find((location) => {
    const imageUrl = wellcomeIiifImageUrl(cleanHttpsUrl(location?.url));
    const licenseInfo = normalizeWellcomeLicense(
      location?.license || item?.license || item?.thumbnail?.license || item?.source?.license
    );
    return Boolean(imageUrl) && licenseInfo.allowed;
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
  const id = cleanText(value?.id || value?.type, 80);
  const label = cleanText(value?.label || value?.title, 160) || id;
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

async function loadBalancedReviewImages({ candidates, attempted, excludedUrls, sourceOrder, providerDiagnostics }) {
  const groups = new Map(SOURCE_ORDER.map((source) => [source, []]));
  for (const candidate of candidates) {
    const key = canonicalCandidateKey(candidate);
    if (!key || attempted.has(key) || isExcludedCandidate(candidate, excludedUrls)) continue;
    if (!groups.has(candidate.source)) groups.set(candidate.source, []);
    groups.get(candidate.source).push(candidate);
  }

  const loaded = [];
  const failures = [];
  const attemptsBySource = Object.fromEntries(SOURCE_ORDER.map((source) => [source, 0]));
  const loadedSources = new Set();

  for (const source of sourceOrder) {
    const result = await loadOneFromSource(groups.get(source) || [], source, attempted, attemptsBySource, providerDiagnostics);
    failures.push(...result.failures);
    if (result.loaded) {
      loaded.push({ ...result.loaded, index: loaded.length });
      loadedSources.add(source);
    }
  }

  while (loaded.length < REVIEW_IMAGES_PER_CYCLE) {
    let progress = false;
    for (const source of sourceOrder) {
      if (loaded.length >= REVIEW_IMAGES_PER_CYCLE) break;
      const group = groups.get(source) || [];
      if (!group.length || attemptsBySource[source] >= MAX_LOAD_ATTEMPTS_PER_SOURCE) continue;
      const result = await loadOneFromSource(group, source, attempted, attemptsBySource, providerDiagnostics);
      failures.push(...result.failures);
      if (result.loaded) {
        loaded.push({ ...result.loaded, index: loaded.length });
        loadedSources.add(source);
      }
      progress = true;
    }
    if (!progress) break;
  }

  return { loaded, failures, loadedSources: [...loadedSources] };
}

async function loadOneFromSource(group, source, attempted, attemptsBySource, providerDiagnostics) {
  const failures = [];
  while (group.length && attemptsBySource[source] < MAX_LOAD_ATTEMPTS_PER_SOURCE) {
    const candidate = group.shift();
    const key = canonicalCandidateKey(candidate);
    if (!key || attempted.has(key)) continue;
    attempted.add(key);
    attemptsBySource[source] += 1;
    providerDiagnostics[source].loadAttempts += 1;

    try {
      const loaded = await loadCandidateImage(candidate);
      providerDiagnostics[source].loaded += 1;
      return { loaded, failures };
    } catch (error) {
      const message = cleanText(error instanceof Error ? error.message : String(error), 300);
      providerDiagnostics[source].imageErrors += 1;
      providerDiagnostics[source].lastImageError = message;
      failures.push({ source, message });
    }
  }
  return { loaded: null, failures };
}

async function loadCandidateImage(candidate) {
  const attempts = uniqueUrls(candidate.reviewUrls?.length ? candidate.reviewUrls : [candidate.url]);
  let lastError = 'No usable image URL.';

  for (const url of attempts) {
    try {
      const response = await fetchWithTimeout(url, { headers: { Accept: 'image/*' } });
      if (!response.ok) throw new Error(`Image returned ${response.status}.`);
      const contentType = (response.headers.get('content-type') || candidate.mimeType || '').split(';')[0].trim();
      if (!contentType.startsWith('image/')) {
        throw new Error(`Candidate returned ${contentType || 'an unknown type'}, not an image.`);
      }
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > MAX_IMAGE_BYTES) {
        throw new Error(`Candidate image exceeded ${MAX_IMAGE_BYTES} bytes.`);
      }
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) {
        throw new Error('Candidate image size was invalid.');
      }
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

  throw new Error(lastError);
}

async function createGroundedVisualBrief(context, env) {
  const prompt = [
    'Use Google Search grounding before answering.',
    'Research authoritative explanations and representative web images for the scientific or educational subject below.',
    'All alt texts describe one intended lecture image. Build one accurate visual brief from all of them.',
    'List concrete required visual features that must be visibly present in a correct image.',
    'Create one concise English keyword query suitable for Wikimedia Commons, Openverse, and Wellcome Collection.',
    context.searchRun > 0
      ? `This is alternative search run ${context.searchRun}. Use different precise scientific synonyms and collection terminology.`
      : '',
    `Visible image label: ${context.label}`,
    `Image id: ${context.imageId || 'not provided'}`,
    `Alt texts: ${JSON.stringify(context.altTexts)}`
  ].filter(Boolean).join('\n');

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
    maxOutputTokens: 700,
    googleSearch: true
  });
}

async function reviewCycleImages(context, env) {
  const parts = [{
    text: [
      'Judge only the visible pixels in the attached candidate images.',
      'Do not use filenames, titles, descriptions, provider names, licenses, or search-query overlap as evidence of relevance.',
      'All alt texts describe one intended lecture image.',
      'A candidate is acceptable only when its visible content directly represents the image label and covers the required visual features.',
      'Reject generic, decorative, merely related, text-only, wrong-pathway, wrong-anatomy, wrong-organism, wrong-scale, or wrong-process images.',
      'For each candidate, list concrete visible matched features, missing required features, and contradictions.',
      `Set accept=true only when resemblanceScore is at least ${ACCEPT_SCORE}, visualCoverage is at least ${MIN_VISUAL_COVERAGE}, labelMatch is true, no required feature is missing, and no contradiction exists.`,
      'Create one new concise provider query that specifically corrects the rejected candidates.',
      'The next query must differ from all prior queries.',
      `Cycle: ${context.cycle} of ${MAX_CYCLES}`,
      `Current query: ${context.query}`,
      `Already accepted images: ${context.acceptedCount}`,
      `Visible image label: ${context.label}`,
      `Image id: ${context.imageId || 'not provided'}`,
      `Alt texts: ${JSON.stringify(context.altTexts)}`,
      `Grounded visual brief: ${context.visualBrief}`,
      `Key concepts: ${JSON.stringify(context.keyConcepts)}`,
      `Required visible features: ${JSON.stringify(context.expectedVisualFeatures)}`,
      `Queries already used: ${JSON.stringify(context.usedQueries)}`
    ].join('\n')
  }];

  for (let index = 0; index < context.candidates.length; index += 1) {
    const candidate = context.candidates[index];
    parts.push({ text: `Candidate ${index}` });
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
              accept: { type: 'boolean' },
              labelMatch: { type: 'boolean' },
              resemblanceScore: { type: 'integer' },
              visualCoverage: { type: 'integer' },
              matchedFeatures: { type: 'array', items: { type: 'string' } },
              missingRequiredFeatures: { type: 'array', items: { type: 'string' } },
              contradictions: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' }
            },
            required: [
              'index',
              'accept',
              'labelMatch',
              'resemblanceScore',
              'visualCoverage',
              'matchedFeatures',
              'missingRequiredFeatures',
              'contradictions',
              'reason'
            ],
            additionalProperties: false
          }
        },
        nextQuery: { type: 'string' }
      },
      required: ['decisions', 'nextQuery'],
      additionalProperties: false
    },
    env,
    maxOutputTokens: 1400,
    googleSearch: false
  });

  return {
    decisions: normalizeStrictDecisions(result.data?.decisions, context.candidates.length),
    nextQuery: cleanQuery(result.data?.nextQuery)
  };
}

function meetsStrictAcceptance(decision, requiredEvidenceCount) {
  return decision.accept === true
    && decision.labelMatch === true
    && decision.resemblanceScore >= ACCEPT_SCORE
    && decision.visualCoverage >= MIN_VISUAL_COVERAGE
    && decision.matchedFeatures.length >= requiredEvidenceCount
    && decision.missingRequiredFeatures.length === 0
    && decision.contradictions.length === 0;
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
  const expectedVisualFeatures = normalizeTexts(data.expectedVisualFeatures, 12, 240);
  const fallbackFeatures = normalizeTexts([...keyConcepts, label, imageId], 6, 180);

  return {
    data: {
      visualBrief: cleanText(data.visualBrief, 1000) || altTexts.join(' ').slice(0, 1000),
      keyConcepts: keyConcepts.length ? keyConcepts : normalizeTexts([label, imageId], 4, 180),
      expectedVisualFeatures: expectedVisualFeatures.length ? expectedVisualFeatures : fallbackFeatures,
      firstSearchQuery: cleanQuery(data.firstSearchQuery)
    },
    grounding: result?.grounding || { used: false, queries: [], sources: [] }
  };
}

function normalizeStrictDecisions(values, candidateCount) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const index = Number(value?.index);
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount || seen.has(index)) continue;
    seen.add(index);
    output.push({
      index,
      accept: value?.accept === true,
      labelMatch: value?.labelMatch === true,
      resemblanceScore: clampScore(value?.resemblanceScore),
      visualCoverage: clampScore(value?.visualCoverage),
      matchedFeatures: normalizeTexts(value?.matchedFeatures, 12, 180),
      missingRequiredFeatures: normalizeTexts(value?.missingRequiredFeatures, 12, 180),
      contradictions: normalizeTexts(value?.contradictions, 12, 180),
      reason: cleanText(value?.reason, 300)
    });
  }

  return output;
}

function createProviderDiagnostics() {
  return Object.fromEntries(SOURCE_ORDER.map((source) => [source, {
    searchCalls: 0,
    rawFound: 0,
    eligibleFound: 0,
    loadAttempts: 0,
    loaded: 0,
    reviewed: 0,
    accepted: 0,
    rejected: 0,
    searchErrors: 0,
    imageErrors: 0,
    lastSearchError: '',
    lastImageError: ''
  }]));
}

function mergeProviderDiagnostics(target, providers) {
  for (const source of SOURCE_ORDER) {
    const status = providers[source] || {
      ok: false,
      rawFound: 0,
      eligibleFound: 0,
      error: 'Provider did not report a status.'
    };
    target[source].searchCalls += 1;
    target[source].rawFound += Number(status.rawFound) || 0;
    target[source].eligibleFound += Number(status.eligibleFound) || 0;
    if (!status.ok) {
      target[source].searchErrors += 1;
      target[source].lastSearchError = cleanText(status.error, 300);
    }
  }
}

function rotatedSourceOrder(cycle, searchRun) {
  const shift = Math.abs((Number(cycle) - 1) + Number(searchRun || 0)) % SOURCE_ORDER.length;
  return [...SOURCE_ORDER.slice(shift), ...SOURCE_ORDER.slice(0, shift)];
}

function isExcludedCandidate(candidate, excludedUrls) {
  if (!(excludedUrls instanceof Set) || excludedUrls.size === 0) return false;
  return [candidate?.url, candidate?.originalUrl, candidate?.sourcePage]
    .map(cleanHttpsUrl)
    .filter(Boolean)
    .some((url) => excludedUrls.has(url));
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
    resemblanceScore: candidate.resemblanceScore,
    visualCoverage: candidate.visualCoverage,
    matchedFeatures: candidate.matchedFeatures,
    acceptanceReason: candidate.acceptanceReason
  };
}

function canonicalCandidateKey(candidate) {
  return cleanHttpsUrl(candidate?.originalUrl) || cleanHttpsUrl(candidate?.url);
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

function extractWellcomeCreator(values) {
  if (!Array.isArray(values)) return '';
  return values.map((item) => cleanText(item?.agent?.label || item?.label, 160)).filter(Boolean).slice(0, 3).join(', ');
}

function wellcomeDescription(item) {
  const subjects = (item?.source?.subjects || []).map((value) => value?.label).filter(Boolean);
  const genres = (item?.source?.genres || []).map((value) => value?.label).filter(Boolean);
  return cleanText(
    [item?.source?.description, item?.source?.lettering, item?.description, ...subjects, ...genres]
      .filter(Boolean)
      .join(' · '),
    360
  );
}

function normalizeTags(values) {
  if (!Array.isArray(values)) return '';
  return values.map((item) => cleanText(item?.name || item, 80)).filter(Boolean).slice(0, 20).join(', ');
}

function formatOpenverseLicense(value, version) {
  const code = normalize(value).replace(/ /g, '-');
  const labels = {
    cc0: 'CC0',
    pdm: 'Public Domain Mark',
    by: 'CC BY',
    'by-sa': 'CC BY-SA',
    'by-nc': 'CC BY-NC',
    'by-nc-sa': 'CC BY-NC-SA'
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
  return [
    cleanText(title, 240) || 'Untitled image',
    cleanText(creator, 200),
    cleanText(license, 120)
  ].filter(Boolean).join(' — ');
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

function normalizeSearchRun(value) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(0, Math.min(999, number)) : 0;
}

function normalizeExcludedUrls(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanHttpsUrl).filter(Boolean))].slice(0, 120);
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

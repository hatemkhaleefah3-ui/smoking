const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_CYCLES = 6;
const MIN_ACCEPTED_IMAGES = 5;
const PREFERRED_ACCEPTED_IMAGES = 20;
const MAX_ACCEPTED_IMAGES = 30;
const EXTRA_CYCLES_AFTER_MINIMUM = 2;
const RESULTS_PER_SOURCE = 20;
const REVIEW_IMAGES_PER_CYCLE = 4;
const ACCEPT_SCORE = 70;
const MAX_IMAGE_BYTES = 1_200_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = 'LecturePublisherMultiSourceSearch/1.0 (https://github.com/hatemkhaleefah3-ui/smoking)';
const SOURCE_ORDER = ['Wikimedia Commons', 'Openverse', 'Wellcome Collection'];
const OPENVERSE_LICENSES = ['cc0', 'pdm', 'by', 'by-sa', 'by-nc', 'by-nc-sa'];

export async function handleMultiSourceMediaSearch(request, env) {
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
    const seen = new Set();
    const usedQueries = new Set();
    const cycles = [];
    let query = cleanQuery(grounded.data.firstSearchQuery)
      || deterministicQuery(label, imageId, grounded.data.keyConcepts);
    let extraCyclesRemaining = null;
    let stoppedReason = 'maximum-cycles';

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
      query = ensureUnusedQuery(query, usedQueries, label, grounded.data.keyConcepts, cycle);
      usedQueries.add(normalize(query));

      const discovered = await discoverAllSources(query);
      const reviewCandidates = chooseBalancedCandidates(discovered, seen, REVIEW_IMAGES_PER_CYCLE);
      const reviewable = await loadReviewImages(reviewCandidates);
      if (!reviewable.length) {
        cycles.push({ cycle, query, discovered: discovered.length, visuallyReviewed: 0, accepted: 0, totalAccepted: accepted.size, sources: countSources(discovered) });
        query = fallbackNextQuery({ label, imageId, keyConcepts: grounded.data.keyConcepts, expectedVisualFeatures: grounded.data.expectedVisualFeatures, rejectedReasons: [], cycle });
        continue;
      }

      const review = await reviewCycleImages({
        cycle,
        query,
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
        if (accepted.size >= MAX_ACCEPTED_IMAGES) break;
      }

      cycles.push({
        cycle,
        query,
        discovered: discovered.length,
        visuallyReviewed: reviewable.length,
        accepted: acceptedThisCycle,
        totalAccepted: accepted.size,
        sources: countSources(discovered)
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
      preferredTargetReached: imageResults.length >= PREFERRED_ACCEPTED_IMAGES,
      visualReview: true,
      multiSource: true,
      allowedLicenses: ['CC0', 'Public Domain', 'CC BY', 'CC BY-SA', 'CC BY-NC', 'CC BY-NC-SA'],
      googleSearchGrounding: grounded.grounding.used,
      groundingQueries: grounded.grounding.queries,
      groundingSources: grounded.grounding.sources,
      searchedQueries: cycles.map((item) => item.query),
      sourceCounts: countSources(ranked),
      cycles,
      stoppedReason
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'multisource_visual_search_fallback',
      message: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }
}

async function discoverAllSources(query) {
  const searches = [searchWikimedia(query), searchOpenverse(query), searchWellcome(query)];
  const settled = await Promise.allSettled(searches);
  const output = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') output.push(...result.value);
  }
  return output;
}

async function searchWikimedia(query) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query,
    gsrlimit: String(RESULTS_PER_SOURCE), gsrnamespace: '6', prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiextmetadatafilter: 'ImageDescription|ObjectName|Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms',
    iiurlwidth: '512', format: 'json'
  });
  const response = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: providerHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}.`);
  const payload = await response.json();
  if (payload?.error) throw new Error(`Wikimedia Commons API error: ${payload.error.code || 'unknown'}.`);

  const output = [];
  for (const page of Object.values(payload?.query?.pages || {})) {
    const info = page?.imageinfo?.[0];
    const url = cleanHttpsUrl(info?.thumburl || info?.url);
    if (!url) continue;
    const metadata = info.extmetadata || {};
    const title = sanitizeTitle(page?.title);
    const creator = stripMarkup(metadata.Artist?.value || metadata.Credit?.value || '');
    const license = stripMarkup(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || 'See source page');
    output.push({
      url,
      originalUrl: cleanHttpsUrl(info?.url),
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
    headers: providerHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Openverse returned ${response.status}.`);
  const payload = await response.json();
  const output = [];
  for (const item of payload?.results || []) {
    const licenseCode = normalize(item?.license);
    if (!OPENVERSE_LICENSES.includes(licenseCode.replace(/ /g, '-'))) continue;
    const url = cleanHttpsUrl(item?.thumbnail || item?.url);
    if (!url) continue;
    const license = formatOpenverseLicense(item?.license, item?.license_version);
    output.push({
      url,
      originalUrl: cleanHttpsUrl(item?.url),
      source: 'Openverse',
      title: cleanText(item?.title, 240) || 'Untitled image',
      description: normalizeTags(item?.tags).slice(0, 360),
      creator: cleanText(item?.creator, 200),
      creatorUrl: cleanHttpsUrl(item?.creator_url),
      license,
      licenseUrl: cleanHttpsUrl(item?.license_url) || licenseUrlFor(license),
      attribution: cleanText(item?.attribution, 600) || buildAttribution(item?.title, item?.creator, license),
      sourcePage: cleanHttpsUrl(item?.foreign_landing_url || item?.detail_url),
      mimeType: normalizeMimeFromUrl(item?.thumbnail || item?.url)
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
    headers: providerHeaders('application/json')
  });
  if (!response.ok) throw new Error(`Wellcome Collection returned ${response.status}.`);
  const payload = await response.json();
  const output = [];
  for (const item of payload?.results || []) {
    const location = chooseWellcomeLocation(item);
    const url = cleanHttpsUrl(location?.url || item?.thumbnail?.url);
    const licenseInfo = normalizeWellcomeLicense(location?.license || item?.thumbnail?.license);
    if (!url || !licenseInfo.allowed) continue;
    const creator = extractWellcomeCreator(item?.source?.contributors);
    const title = cleanText(item?.source?.title, 260) || `Wellcome image ${cleanText(item?.id, 80)}`;
    output.push({
      url,
      originalUrl: url,
      source: 'Wellcome Collection',
      title,
      description: wellcomeDescription(item),
      creator,
      creatorUrl: '',
      license: licenseInfo.label,
      licenseUrl: licenseInfo.url,
      attribution: cleanText(location?.credit || item?.thumbnail?.credit, 600) || buildAttribution(title, creator || 'Wellcome Collection', licenseInfo.label),
      sourcePage: item?.source?.id ? `https://wellcomecollection.org/works/${encodeURIComponent(item.source.id)}` : '',
      mimeType: normalizeMimeFromUrl(url)
    });
  }
  return output;
}

function chooseWellcomeLocation(item) {
  const values = [item?.thumbnail, ...(Array.isArray(item?.locations) ? item.locations : [])].filter(Boolean);
  return values.find((location) => cleanHttpsUrl(location?.url) && normalizeWellcomeLicense(location?.license).allowed) || null;
}

function normalizeWellcomeLicense(value) {
  const id = cleanText(value?.id, 80);
  const label = cleanText(value?.label, 160) || id;
  const normalized = normalize(`${id} ${label}`).replace(/ /g, '-');
  if (!normalized || /(^|-)nd($|-)|no-derivatives|in-copyright|rights-reserved|unknown|restricted/.test(normalized)) {
    return { allowed: false, label, url: '' };
  }
  const allowed = /cc0|public-domain|pdm|cc-by-nc-sa|cc-by-nc|cc-by-sa|cc-by/.test(normalized);
  return { allowed, label: canonicalLicenseLabel(label || id), url: cleanHttpsUrl(value?.url) || licenseUrlFor(label || id) };
}

function chooseBalancedCandidates(candidates, seen, limit) {
  const groups = new Map(SOURCE_ORDER.map((source) => [source, []]));
  for (const candidate of candidates) {
    const key = canonicalCandidateKey(candidate);
    if (!key || seen.has(key)) continue;
    if (!groups.has(candidate.source)) groups.set(candidate.source, []);
    groups.get(candidate.source).push(candidate);
  }
  const selected = [];
  while (selected.length < limit) {
    let added = false;
    for (const source of SOURCE_ORDER) {
      const candidate = groups.get(source)?.shift();
      if (!candidate) continue;
      const key = canonicalCandidateKey(candidate);
      seen.add(key);
      selected.push(candidate);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  if (selected.length < limit) {
    for (const group of groups.values()) {
      while (group.length && selected.length < limit) {
        const candidate = group.shift();
        const key = canonicalCandidateKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
      }
    }
  }
  return selected;
}

async function loadReviewImages(candidates) {
  const settled = await Promise.allSettled(candidates.map(async (candidate, index) => {
    const response = await fetchWithTimeout(candidate.url, { headers: providerHeaders('image/*') });
    if (!response.ok) throw new Error(`Image returned ${response.status}.`);
    const contentType = (response.headers.get('content-type') || candidate.mimeType || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) throw new Error('Candidate was not an image.');
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_IMAGE_BYTES) throw new Error('Candidate image was too large.');
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('Candidate image size was invalid.');
    return { ...candidate, index, mimeType: contentType, base64: arrayBufferToBase64(buffer) };
  }));
  return settled.filter((result) => result.status === 'fulfilled').map((result, index) => ({ ...result.value, index }));
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
              index: { type: 'integer' }, resembles: { type: 'boolean' },
              resemblanceScore: { type: 'integer' }, reason: { type: 'string' }
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
  return { decisions: normalizeDecisions(result.data?.decisions, context.candidates.length), nextQuery: cleanQuery(result.data?.nextQuery) };
}

async function callGeminiStructured({ parts, schema, env, maxOutputTokens, googleSearch }) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim() ? env.GEMINI_MODEL.trim() : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens, responseFormat: { text: { mimeType: 'application/json', schema } } }
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
  const text = (candidate?.content?.parts || []).map((part) => typeof part?.text === 'string' ? part.text : '').join(' ')
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Gemini did not return the required structured result.'); }
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
    const uri = cleanHttpsUrl(chunk?.web?.uri);
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: cleanText(chunk?.web?.title, 180) || new URL(uri).hostname, uri });
    if (sources.length >= 12) break;
  }
  return { used: Boolean(queries.length || sources.length), queries, sources };
}

function publicResult(candidate) {
  return {
    url: candidate.url,
    originalUrl: candidate.originalUrl || candidate.url,
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

function stripReviewData(candidate) {
  const { base64, index, ...value } = candidate;
  return value;
}

function canonicalCandidateKey(candidate) {
  return normalize(candidate.sourcePage || candidate.originalUrl || candidate.url);
}

function countSources(candidates) {
  const counts = {};
  for (const candidate of candidates || []) counts[candidate.source] = (counts[candidate.source] || 0) + 1;
  return counts;
}

function normalizeDecisions(values, count) {
  if (!Array.isArray(values)) return [];
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const index = Number(value?.index);
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) continue;
    seen.add(index);
    output.push({ index, resembles: value?.resembles === true, resemblanceScore: clampScore(value?.resemblanceScore), reason: cleanText(value?.reason, 240) });
  }
  return output;
}

function ensureUnusedQuery(value, used, label, concepts, cycle) {
  const query = cleanQuery(value);
  if (query && !used.has(normalize(query))) return query;
  return fallbackNextQuery({ label, imageId: '', keyConcepts: concepts, expectedVisualFeatures: [], rejectedReasons: [], cycle });
}

function fallbackNextQuery(context) {
  const pieces = [context.label, ...context.keyConcepts.slice(context.cycle - 1, context.cycle + 2), ...context.expectedVisualFeatures.slice(0, 2), ...context.rejectedReasons.slice(0, 1), context.imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' ')];
  return cleanQuery(pieces.filter(Boolean).join(' ')).slice(0, 180) || `lecture image ${context.cycle}`;
}

function deterministicQuery(label, imageId, concepts) {
  return cleanQuery([label, imageId.replace(/^img[-_]?/i, '').replace(/[-_]+/g, ' '), ...concepts.slice(0, 4)].join(' '));
}

function providerHeaders(accept) {
  return { Accept: accept, 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT };
}

function formatOpenverseLicense(code, version) {
  const label = canonicalLicenseLabel(code);
  return version ? `${label} ${cleanText(version, 20)}` : label;
}

function canonicalLicenseLabel(value) {
  const normalized = normalize(value).replace(/ /g, '-');
  if (/cc0/.test(normalized)) return 'CC0';
  if (/pdm|public-domain/.test(normalized)) return 'Public Domain Mark';
  if (/by-nc-sa/.test(normalized)) return 'CC BY-NC-SA';
  if (/by-nc/.test(normalized)) return 'CC BY-NC';
  if (/by-sa/.test(normalized)) return 'CC BY-SA';
  if (/(^|-)by($|-)/.test(normalized)) return 'CC BY';
  return cleanText(value, 160) || 'License stated on source page';
}

function licenseUrlFor(value) {
  const label = canonicalLicenseLabel(value);
  if (label === 'CC0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (label === 'Public Domain Mark') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  if (label === 'CC BY') return 'https://creativecommons.org/licenses/by/4.0/';
  if (label === 'CC BY-SA') return 'https://creativecommons.org/licenses/by-sa/4.0/';
  if (label === 'CC BY-NC') return 'https://creativecommons.org/licenses/by-nc/4.0/';
  if (label === 'CC BY-NC-SA') return 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
  return '';
}

function buildAttribution(title, creator, license) {
  return [cleanText(title, 240), creator ? `by ${cleanText(creator, 200)}` : '', license].filter(Boolean).join(' — ');
}

function extractWellcomeCreator(values) {
  if (!Array.isArray(values)) return '';
  return values.map((value) => cleanText(value?.agent?.label || value?.label, 160)).filter(Boolean).slice(0, 3).join(', ');
}

function wellcomeDescription(item) {
  const values = [item?.source?.description, ...(item?.source?.subjects || []).map((x) => x?.label), ...(item?.source?.genres || []).map((x) => x?.label)];
  return values.map((value) => cleanText(value, 200)).filter(Boolean).join(', ').slice(0, 360);
}

function normalizeTags(values) {
  if (!Array.isArray(values)) return '';
  return values.map((value) => cleanText(value?.name || value, 80)).filter(Boolean).join(', ');
}

function normalizeMime(value) {
  return typeof value === 'string' && value.startsWith('image/') ? value : 'image/jpeg';
}

function normalizeMimeFromUrl(value) {
  const path = String(value || '').toLowerCase();
  if (/\.png(?:$|\?)/.test(path)) return 'image/png';
  if (/\.webp(?:$|\?)/.test(path)) return 'image/webp';
  if (/\.gif(?:$|\?)/.test(path)) return 'image/gif';
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

function cleanQuery(value) {
  return cleanText(value, 240).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').replace(/^[-–—,:;]+|[-–—,:;]+$/g, '').trim();
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function sanitizeTitle(value) {
  return String(value || '').replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim();
}

function stripMarkup(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function cleanHttpsUrl(value) {
  if (typeof value !== 'string') return '';
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

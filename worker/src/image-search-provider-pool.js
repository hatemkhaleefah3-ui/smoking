'use strict';

const PROVIDER_RESULT_LIMIT = 24;
const USER_AGENT = 'LectureStudioImageSearch/2.0 (https://smoking-e1j.pages.dev; educational image discovery)';
const WIKIMEDIA_TIMEOUT_MS = 5_000;
const OPENVERSE_TIMEOUT_MS = 6_000;
const OPEN_I_TIMEOUT_MS = 4_500;
const DEBUG_BODY_LIMIT = 50_000;
const RAW_BODY_PREVIEW_LENGTH = 500;

export async function searchProviderPool({ query, suffix = '', debug = false }) {
  const baseQuery = normalizeText(query, 160);
  const topicSuffix = normalizeText(suffix, 120);
  const combinedQuery = topicSuffix ? `${baseQuery} ${topicSuffix}` : baseQuery;
  const diagnostics = [];

  const providers = [
    ['wikimedia', () => searchWikimedia({ baseQuery, combinedQuery, diagnostics, debug })],
    ['openverse', () => searchOpenverse({ query: combinedQuery, diagnostics, debug })],
    ['nlm-open-i', () => searchOpenI({ baseQuery, combinedQuery, diagnostics, debug })]
  ];

  const settled = await Promise.allSettled(
    providers.map(([source, runner]) => runProvider(source, runner))
  );

  const results = [];
  const sourceStatus = [];
  settled.forEach((outcome, index) => {
    const source = providers[index][0];
    if (outcome.status === 'fulfilled') {
      results.push(...outcome.value.results);
      sourceStatus.push(outcome.value.status);
      return;
    }
    sourceStatus.push(softFailureStatus(source, outcome.reason));
  });

  const dedupedResults = dedupeResults(results);
  const pipelineCounts = {
    rawByProvider: Object.fromEntries(sourceStatus.map((item) => [item.source, Number(item.rawCount || 0)])),
    afterProviderFilteringByProvider: Object.fromEntries(sourceStatus.map((item) => [item.source, Number(item.afterProviderFilterCount ?? item.count ?? 0)])),
    beforeCrossProviderDedup: results.length,
    afterCrossProviderDedup: dedupedResults.length
  };

  console.log(JSON.stringify({
    event: 'adaptive_image_provider_diagnostics',
    query: baseQuery,
    externalQuery: combinedQuery,
    pipelineCounts,
    providers: diagnostics.map(compactDiagnosticForLog)
  }));

  return {
    query: baseQuery,
    externalQuery: combinedQuery,
    results: dedupedResults,
    sourceStatus,
    pipelineCounts,
    diagnostics: debug ? diagnostics : undefined
  };
}

async function runProvider(source, runner) {
  try {
    const value = await runner();
    const results = Array.isArray(value.results) ? value.results : [];
    const status = value.status || {};
    return {
      results,
      status: {
        source,
        ok: true,
        count: results.length,
        rawCount: Number(status.rawCount ?? results.length),
        afterProviderFilterCount: Number(status.afterProviderFilterCount ?? results.length),
        timedOut: false,
        skipped: false,
        failureType: null,
        fetchThrew: false,
        ...status
      }
    };
  } catch (error) {
    return { results: [], status: softFailureStatus(source, error) };
  }
}

function softFailureStatus(source, error) {
  const diagnostic = error?.diagnostic || {};
  const failureType = diagnostic.failureType || classifyFailure(error, diagnostic);
  const timedOut = failureType === 'timeout';
  const message = providerFailureMessage(source, failureType, diagnostic);

  console.error(JSON.stringify({
    event: 'adaptive_image_provider_skipped',
    source,
    failureType,
    timedOut,
    message,
    providerErrorName: error instanceof Error ? error.name : typeof error,
    providerErrorMessage: error instanceof Error ? error.message : String(error),
    diagnostic: compactDiagnosticForLog(diagnostic)
  }));

  return {
    source,
    ok: false,
    count: 0,
    rawCount: Number(diagnostic.parsedResultCount || 0),
    afterProviderFilterCount: Number(diagnostic.afterProviderFilterCount || 0),
    timedOut,
    skipped: true,
    failureType,
    message,
    error: error instanceof Error ? error.message : String(error),
    providerErrorName: error instanceof Error ? error.name : typeof error,
    providerErrorMessage: error instanceof Error ? error.message : String(error),
    fetchThrew: Boolean(diagnostic.fetchThrew),
    fetchErrorName: diagnostic.fetchErrorName || null,
    fetchErrorMessage: diagnostic.fetchErrorMessage || null,
    requestUrl: diagnostic.requestUrl || null,
    status: diagnostic.responseStatus ?? diagnostic.status ?? null,
    responseOk: diagnostic.responseOk ?? diagnostic.ok ?? false,
    responseType: diagnostic.contentType || null,
    rawBodyPreview: diagnostic.rawBodyPreview || ''
  };
}

function providerFailureMessage(source, failureType, diagnostic) {
  const label = sourceLabel(source);
  if (failureType === 'timeout') return `${label} timed out, showing other sources.`;
  if (failureType === 'network') return `${label}: no response (network/CORS error), showing other sources.`;
  if (failureType === 'http') {
    const status = diagnostic.responseStatus ?? diagnostic.status;
    return `${label} server returned${status == null ? ' an error' : ` HTTP ${status}`}; showing other sources.`;
  }
  if (failureType === 'parse') return `${label} returned an unreadable response; showing other sources.`;
  return `${label} failed for an unexpected reason; showing other sources.`;
}

function classifyFailure(error, diagnostic) {
  if (error?.timedOut || diagnostic?.timedOut || error?.name === 'AbortError') return 'timeout';
  if (diagnostic?.responseStatus != null || diagnostic?.status != null) {
    if (diagnostic?.failureType === 'parse') return 'parse';
    return 'http';
  }
  const name = diagnostic?.fetchErrorName || (error instanceof Error ? error.name : '');
  if (name === 'TypeError') return 'network';
  return 'other';
}

async function searchWikimedia({ baseQuery, combinedQuery, diagnostics, debug }) {
  let first;
  try {
    first = await attemptWikimedia(combinedQuery, 'combined-query', diagnostics, debug);
  } catch (error) {
    first = { results: [], error, diagnostic: error?.diagnostic || null };
  }

  const topicQueryCount = first.results.length;
  const needsFallback = normalizeKey(combinedQuery) !== normalizeKey(baseQuery) && topicQueryCount === 0;
  if (!needsFallback) {
    if (first.error) throw first.error;
    return {
      results: first.results,
      status: statusFromDiagnostic(first.diagnostic, {
        fallbackUsed: false,
        topicQueryCount,
        rawCount: Number(first.diagnostic?.parsedResultCount || 0),
        afterProviderFilterCount: first.results.length
      })
    };
  }

  const fallback = await attemptWikimedia(baseQuery, 'base-query-fallback', diagnostics, debug);
  return {
    results: fallback.results,
    status: statusFromDiagnostic(fallback.diagnostic, {
      fallbackUsed: true,
      fallbackQuery: baseQuery,
      topicQueryCount,
      rawCount: Number(fallback.diagnostic?.parsedResultCount || 0),
      afterProviderFilterCount: fallback.results.length
    })
  };
}

async function attemptWikimedia(query, stage, diagnostics, debug) {
  const endpoint = new URL('https://commons.wikimedia.org/w/api.php');
  endpoint.searchParams.set('action', 'query');
  endpoint.searchParams.set('generator', 'search');
  endpoint.searchParams.set('gsrsearch', query);
  endpoint.searchParams.set('gsrnamespace', '6');
  endpoint.searchParams.set('gsrlimit', String(PROVIDER_RESULT_LIMIT));
  endpoint.searchParams.set('prop', 'imageinfo');
  endpoint.searchParams.set('iiprop', 'url|mime|extmetadata|size');
  endpoint.searchParams.set('iiurlwidth', '960');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('formatversion', '2');
  endpoint.searchParams.set('origin', '*');

  const { payload, diagnostic } = await fetchJson(endpoint, {
    source: 'wikimedia', stage, timeoutMs: WIKIMEDIA_TIMEOUT_MS, diagnostics, debug
  });
  const rawPages = payload?.query?.pages;
  const pages = Array.isArray(rawPages) ? rawPages : Object.values(rawPages || {});
  const results = pages.flatMap((page) => {
    const info = page?.imageinfo?.[0];
    if (!info || !String(info.mime || '').startsWith('image/')) return [];
    const imageUrl = normalizeHttpsUrl(info.thumburl || info.url);
    if (!imageUrl) return [];
    const metadata = info.extmetadata || {};
    return [{
      id: `wikimedia:${page.pageid || page.title || imageUrl}`,
      source: 'wikimedia',
      sourceLabel: 'Wikimedia Commons',
      imageUrl,
      originalUrl: normalizeHttpsUrl(info.url) || imageUrl,
      sourceUrl: normalizeHttpsUrl(info.descriptionurl) || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || '')}`,
      title: stripFilePrefix(page.title) || stripHtml(metadata.ObjectName?.value) || query,
      caption: stripHtml(metadata.ImageDescription?.value || metadata.ObjectName?.value || ''),
      creator: stripHtml(metadata.Artist?.value || metadata.Credit?.value || ''),
      license: stripHtml(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || ''),
      licenseUrl: normalizeHttpsUrl(metadata.LicenseUrl?.value),
      width: Number(info.thumbwidth || info.width || 0) || null,
      height: Number(info.thumbheight || info.height || 0) || null
    }];
  });
  diagnostic.parsedResultCount = pages.length;
  diagnostic.afterProviderFilterCount = results.length;
  return { results, diagnostic };
}

async function searchOpenverse({ query, diagnostics, debug }) {
  const endpoint = new URL('https://api.openverse.org/v1/images/');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('page_size', String(PROVIDER_RESULT_LIMIT));
  endpoint.searchParams.set('mature', 'false');

  const { payload, diagnostic } = await fetchJson(endpoint, {
    source: 'openverse', stage: 'image-search', timeoutMs: OPENVERSE_TIMEOUT_MS, diagnostics, debug
  });
  const rawItems = Array.isArray(payload?.results) ? payload.results : [];
  let skippedInvalidPrimary = 0;
  const results = rawItems.flatMap((item) => {
    const primaryUrl = normalizeHttpsUrl(item.url);
    const thumbnailUrl = normalizeHttpsUrl(item.thumbnail);
    if (!primaryUrl) {
      skippedInvalidPrimary += 1;
      return [];
    }
    return [{
      id: `openverse:${item.id || primaryUrl}`,
      source: 'openverse',
      sourceLabel: 'Openverse',
      imageUrl: primaryUrl,
      originalUrl: primaryUrl,
      thumbnailUrl: thumbnailUrl && thumbnailUrl !== primaryUrl ? thumbnailUrl : null,
      sourceUrl: normalizeHttpsUrl(item.foreign_landing_url || item.detail_url) || primaryUrl,
      title: normalizeText(item.title, 240) || query,
      caption: normalizeText(item.description, 1200),
      creator: normalizeText(item.creator, 240),
      collection: normalizeText(item.provider || item.source, 160),
      license: normalizeText(item.license, 80),
      licenseUrl: normalizeHttpsUrl(item.license_url),
      width: Number(item.width || 0) || null,
      height: Number(item.height || 0) || null
    }];
  });
  diagnostic.parsedResultCount = rawItems.length;
  diagnostic.afterProviderFilterCount = results.length;
  return {
    results,
    status: statusFromDiagnostic(diagnostic, {
      skippedInvalidPrimary,
      rawCount: rawItems.length,
      afterProviderFilterCount: results.length
    })
  };
}

async function searchOpenI({ baseQuery, combinedQuery, diagnostics, debug }) {
  const sameQuery = normalizeKey(baseQuery) === normalizeKey(combinedQuery);
  const attempts = sameQuery
    ? [
        { query: baseQuery, stage: 'image-search' },
        { query: baseQuery, stage: 'retry' }
      ]
    : [
        { query: combinedQuery, stage: 'combined-query' },
        { query: baseQuery, stage: 'base-query-fallback' }
      ];

  let firstCount = 0;
  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const response = await attemptOpenI(attempt.query, attempt.stage, diagnostics, debug);
      if (index === 0) firstCount = response.results.length;
      if (response.results.length || index === attempts.length - 1) {
        return {
          results: response.results,
          status: statusFromDiagnostic(response.diagnostic, {
            retryUsed: index > 0,
            fallbackUsed: !sameQuery && index > 0,
            fallbackQuery: !sameQuery && index > 0 ? baseQuery : null,
            topicQueryCount: firstCount,
            rawCount: Number(response.diagnostic?.parsedResultCount || 0),
            afterProviderFilterCount: response.results.length
          })
        };
      }
    } catch (error) {
      lastError = error;
      if (index === attempts.length - 1) throw error;
    }
  }
  if (lastError) throw lastError;
  return { results: [], status: { retryUsed: true, topicQueryCount: firstCount, rawCount: 0, afterProviderFilterCount: 0 } };
}

async function attemptOpenI(query, stage, diagnostics, debug) {
  const endpoint = new URL('https://openi.nlm.nih.gov/api/search');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('m', '1');
  endpoint.searchParams.set('n', String(PROVIDER_RESULT_LIMIT));

  const { payload, diagnostic } = await fetchJson(endpoint, {
    source: 'nlm-open-i', stage, timeoutMs: OPEN_I_TIMEOUT_MS, diagnostics, debug
  });
  const items = normalizeOpenIItems(payload);
  const results = items.flatMap((item, index) => {
    const imagePath = normalizeText(
      item.imgLarge || item.imgThumbLarge || item.imgGrid150 || item.imgThumb ||
      item.imgUrl || item.imageUrl || item.image_url || item.thumbnail || item.thumb,
      1200
    );
    if (!imagePath) return [];
    const imageUrl = absoluteHttpsUrl(imagePath, 'https://openi.nlm.nih.gov');
    if (!imageUrl || imageUrl === 'https://openi.nlm.nih.gov/') return [];
    const recordId = normalizeText(item.uid || item.pmcid || item.imgId || item.imageId || item.id, 180);
    const figureId = normalizeText(item.image?.id, 100);
    const id = [recordId, figureId].filter(Boolean).join(':') || String(index);
    const detailPath = normalizeText(item.detailedQueryURL || item.detailUrl || item.sourceUrl, 1200);
    return [{
      id: `nlm-open-i:${id}`,
      source: 'nlm-open-i',
      sourceLabel: 'NLM Open-i',
      imageUrl,
      originalUrl: imageUrl,
      sourceUrl: detailPath
        ? absoluteHttpsUrl(detailPath, 'https://openi.nlm.nih.gov')
        : `https://openi.nlm.nih.gov/detailedresult?img=${encodeURIComponent(id)}&req=4`,
      title: normalizeText(item.title || item.articleTitle || item.article_title, 300) || query,
      caption: stripHtml(item.image?.caption || item.caption || item.description || item.abstract || ''),
      creator: normalizeText(item.authors || item.author || item.journal_title || item.journal || item.journal_abbr, 300),
      collection: normalizeText(item.journal_title || item.journal || item.journal_abbr, 180),
      license: normalizeText(item.license || item.licenseType, 120) || 'Check source record',
      licenseUrl: normalizeHttpsUrl(item.licenseUrl || item.license_url),
      width: Number(item.width || 0) || null,
      height: Number(item.height || 0) || null
    }];
  });
  diagnostic.parsedResultCount = items.length;
  diagnostic.afterProviderFilterCount = results.length;
  return { results, diagnostic };
}

async function fetchJson(input, { source, stage, timeoutMs, diagnostics, debug }) {
  const requestUrl = String(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('provider-timeout'), timeoutMs);
  const startedAt = Date.now();
  let response;
  let rawBody = '';
  try {
    response = await fetch(input, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Api-User-Agent': USER_AGENT
      },
      signal: controller.signal
    });
    rawBody = await response.text();
    const diagnostic = {
      source,
      stage,
      requestUrl,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      fetchThrew: false,
      fetchErrorName: null,
      fetchErrorMessage: null,
      responseStatus: response.status,
      responseOk: response.ok,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('Content-Type') || '',
      timedOut: false,
      failureType: response.ok ? null : 'http',
      rawBodyPreview: previewBody(rawBody),
      parsedResultCount: null,
      afterProviderFilterCount: null,
      ...(debug ? { rawResponseBody: limitBody(rawBody) } : {})
    };
    diagnostics.push(diagnostic);
    if (!response.ok) throw new ProviderError(`${source} returned HTTP ${response.status}`, diagnostic);
    try {
      return { payload: JSON.parse(rawBody), diagnostic };
    } catch (error) {
      diagnostic.failureType = 'parse';
      diagnostic.parseErrorName = error instanceof Error ? error.name : typeof error;
      diagnostic.parseErrorMessage = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`${source} returned a non-JSON response`, diagnostic);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timedOut = controller.signal.aborted || error?.name === 'AbortError';
    const fetchErrorName = error instanceof Error ? error.name : typeof error;
    const fetchErrorMessage = error instanceof Error ? error.message : String(error);
    const failureType = timedOut ? 'timeout' : fetchErrorName === 'TypeError' ? 'network' : 'other';
    const diagnostic = {
      source,
      stage,
      requestUrl,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      fetchThrew: true,
      fetchErrorName,
      fetchErrorMessage,
      responseStatus: response?.status ?? null,
      responseOk: response?.ok ?? false,
      status: response?.status ?? null,
      ok: false,
      contentType: response?.headers?.get('Content-Type') || '',
      timedOut,
      failureType,
      rawBodyPreview: previewBody(rawBody),
      parsedResultCount: null,
      afterProviderFilterCount: null,
      ...(debug ? { rawResponseBody: limitBody(rawBody) } : {})
    };
    diagnostics.push(diagnostic);
    const wrapped = new ProviderError(
      timedOut ? `${source} timed out after ${timeoutMs}ms` : `${source} request failed: ${fetchErrorName}: ${fetchErrorMessage}`,
      diagnostic
    );
    wrapped.timedOut = timedOut;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

function statusFromDiagnostic(diagnostic, extra = {}) {
  return {
    requestUrl: diagnostic?.requestUrl || null,
    status: diagnostic?.responseStatus ?? diagnostic?.status ?? null,
    responseOk: diagnostic?.responseOk ?? diagnostic?.ok ?? null,
    responseType: diagnostic?.contentType || null,
    rawBodyPreview: diagnostic?.rawBodyPreview || '',
    fetchThrew: Boolean(diagnostic?.fetchThrew),
    fetchErrorName: diagnostic?.fetchErrorName || null,
    fetchErrorMessage: diagnostic?.fetchErrorMessage || null,
    failureType: diagnostic?.failureType || null,
    ...extra
  };
}

function normalizeOpenIItems(payload) {
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.images)) return payload.images;
  if (Array.isArray(payload?.list?.results)) return payload.list.results;
  if (Array.isArray(payload?.response?.docs)) return payload.response.docs;
  return [];
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = normalizeHttpsUrl(result.originalUrl) || normalizeHttpsUrl(result.imageUrl) || result.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeText(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeHttpsUrl(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function absoluteHttpsUrl(value, base) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(raw, base);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function stripHtml(value) {
  return normalizeText(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"), 1600);
}

function stripFilePrefix(value) {
  return normalizeText(value, 300).replace(/^File:/i, '').replace(/\.[a-z0-9]{2,6}$/i, '');
}

function sourceLabel(source) {
  return {
    wikimedia: 'Wikimedia Commons',
    openverse: 'Openverse',
    'nlm-open-i': 'NLM Open-i'
  }[source] || source;
}

function previewBody(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= RAW_BODY_PREVIEW_LENGTH
    ? text
    : `${text.slice(0, RAW_BODY_PREVIEW_LENGTH)}…`;
}

function limitBody(value) {
  const text = String(value || '');
  return text.length <= DEBUG_BODY_LIMIT
    ? text
    : `${text.slice(0, DEBUG_BODY_LIMIT)}\n...[truncated ${text.length - DEBUG_BODY_LIMIT} characters]`;
}

function compactDiagnosticForLog(diagnostic) {
  return {
    source: diagnostic?.source || null,
    stage: diagnostic?.stage || null,
    requestUrl: diagnostic?.requestUrl || null,
    durationMs: diagnostic?.durationMs ?? null,
    fetchThrew: Boolean(diagnostic?.fetchThrew),
    fetchErrorName: diagnostic?.fetchErrorName || null,
    fetchErrorMessage: diagnostic?.fetchErrorMessage || null,
    responseStatus: diagnostic?.responseStatus ?? diagnostic?.status ?? null,
    responseOk: diagnostic?.responseOk ?? diagnostic?.ok ?? null,
    failureType: diagnostic?.failureType || null,
    contentType: diagnostic?.contentType || null,
    rawBodyPreview: diagnostic?.rawBodyPreview || '',
    parsedResultCount: diagnostic?.parsedResultCount ?? null,
    afterProviderFilterCount: diagnostic?.afterProviderFilterCount ?? null
  };
}

class ProviderError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = 'ProviderError';
    this.diagnostic = diagnostic;
    this.timedOut = Boolean(diagnostic?.timedOut);
  }
}

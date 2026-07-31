'use strict';

const PROVIDER_RESULT_LIMIT = 24;
const USER_AGENT = 'LectureStudioImageSearch/2.0 (https://smoking-e1j.pages.dev; educational image discovery)';
const WIKIMEDIA_TIMEOUT_MS = 5_000;
const OPENVERSE_TIMEOUT_MS = 6_000;
const OPEN_I_TIMEOUT_MS = 4_500;
const DEBUG_BODY_LIMIT = 50_000;

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

  return {
    query: baseQuery,
    externalQuery: combinedQuery,
    results: dedupeResults(results),
    sourceStatus,
    diagnostics: debug ? diagnostics : undefined
  };
}

async function runProvider(source, runner) {
  try {
    const value = await runner();
    return {
      results: Array.isArray(value.results) ? value.results : [],
      status: {
        source,
        ok: true,
        count: Array.isArray(value.results) ? value.results.length : 0,
        timedOut: false,
        ...(value.status || {})
      }
    };
  } catch (error) {
    return { results: [], status: softFailureStatus(source, error) };
  }
}

function softFailureStatus(source, error) {
  const diagnostic = error?.diagnostic || {};
  const timedOut = Boolean(error?.timedOut || diagnostic?.timedOut || error?.name === 'AbortError');
  const message = source === 'nlm-open-i'
    ? timedOut
      ? 'NLM Open-i timed out, showing other sources.'
      : 'NLM Open-i could not be reached; showing other sources.'
    : `${sourceLabel(source)} could not be reached; showing other sources.`;

  console.error(JSON.stringify({
    event: 'adaptive_image_provider_skipped',
    source,
    timedOut,
    message,
    error: error instanceof Error ? error.message : String(error),
    diagnostic
  }));

  return {
    source,
    ok: false,
    count: 0,
    timedOut,
    skipped: true,
    message,
    error: error instanceof Error ? error.message : String(error),
    requestUrl: diagnostic.requestUrl || null,
    status: diagnostic.status ?? null,
    responseType: diagnostic.contentType || null
  };
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
        topicQueryCount
      })
    };
  }

  const fallback = await attemptWikimedia(baseQuery, 'base-query-fallback', diagnostics, debug);
  return {
    results: fallback.results,
    status: statusFromDiagnostic(fallback.diagnostic, {
      fallbackUsed: true,
      fallbackQuery: baseQuery,
      topicQueryCount
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
  let skippedInvalidPrimary = 0;
  const results = (payload?.results || []).flatMap((item) => {
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
  return {
    results,
    status: statusFromDiagnostic(diagnostic, { skippedInvalidPrimary })
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
            topicQueryCount: firstCount
          })
        };
      }
    } catch (error) {
      lastError = error;
      if (index === attempts.length - 1) throw error;
    }
  }
  if (lastError) throw lastError;
  return { results: [], status: { retryUsed: true, topicQueryCount: firstCount } };
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
  return { results, diagnostic };
}

async function fetchJson(input, { source, stage, timeoutMs, diagnostics, debug }) {
  const requestUrl = String(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('provider-timeout'), timeoutMs);
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
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('Content-Type') || '',
      timedOut: false,
      ...(debug ? { rawResponseBody: limitBody(rawBody) } : {})
    };
    diagnostics.push(diagnostic);
    if (!response.ok) throw new ProviderError(`${source} returned HTTP ${response.status}`, diagnostic);
    try {
      return { payload: JSON.parse(rawBody), diagnostic };
    } catch (error) {
      throw new ProviderError(`${source} returned a non-JSON response`, {
        ...diagnostic,
        parseError: error instanceof Error ? error.message : String(error)
      });
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timedOut = controller.signal.aborted || error?.name === 'AbortError';
    const diagnostic = {
      source,
      stage,
      requestUrl,
      status: response?.status ?? null,
      ok: false,
      contentType: response?.headers?.get('Content-Type') || '',
      timedOut,
      networkError: error instanceof Error ? error.message : String(error),
      ...(debug ? { rawResponseBody: limitBody(rawBody) } : {})
    };
    diagnostics.push(diagnostic);
    const wrapped = new ProviderError(
      timedOut ? `${source} timed out after ${timeoutMs}ms` : `${source} request failed`,
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
    status: diagnostic?.status ?? null,
    responseType: diagnostic?.contentType || null,
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

function limitBody(value) {
  const text = String(value || '');
  return text.length <= DEBUG_BODY_LIMIT
    ? text
    : `${text.slice(0, DEBUG_BODY_LIMIT)}\n...[truncated ${text.length - DEBUG_BODY_LIMIT} characters]`;
}

class ProviderError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = 'ProviderError';
    this.diagnostic = diagnostic;
    this.timedOut = Boolean(diagnostic?.timedOut);
  }
}

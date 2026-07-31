'use strict';

export async function applyOpenverseImageSafety(response) {
  if (!response || !isJsonResponse(response) || response.status < 200 || response.status >= 300) return response;

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return rebuildResponse(response, text);
  }

  if (!payload || !Array.isArray(payload.results)) return rebuildResponse(response, text);

  let skippedInvalidPrimary = 0;
  const results = payload.results.flatMap((result) => {
    if (result?.source !== 'openverse') return [result];

    // Before this guard, imageUrl contained Openverse's thumbnail first and
    // originalUrl contained the provider's primary `url` field. Older cache
    // entries can contain the thumbnail in both fields when `url` was missing.
    const thumbnailCandidate = normalizeHttpsUrl(result.thumbnailUrl || result.imageUrl);
    const legacyThumbnailOnly = !result.thumbnailUrl
      && sameUrl(result.originalUrl, result.imageUrl)
      && isOpenverseThumbnailUrl(result.imageUrl);
    const primaryUrl = legacyThumbnailOnly ? '' : normalizeHttpsUrl(result.originalUrl);

    if (!primaryUrl) {
      skippedInvalidPrimary += 1;
      console.warn(JSON.stringify({
        event: 'openverse_result_skipped',
        id: result.id || null,
        title: result.title || null,
        reason: legacyThumbnailOnly
          ? 'missing-primary-url-thumbnail-only'
          : classifyInvalidPrimary(result.originalUrl)
      }));
      return [];
    }

    return [{
      ...result,
      imageUrl: primaryUrl,
      originalUrl: primaryUrl,
      thumbnailUrl: thumbnailCandidate && thumbnailCandidate !== primaryUrl ? thumbnailCandidate : null,
      openversePrimaryStatus: 'valid-https'
    }];
  });

  const sourceStatus = Array.isArray(payload.sourceStatus)
    ? payload.sourceStatus.map((status) => {
        if (status?.source !== 'openverse') return status;
        return {
          ...status,
          count: results.filter((result) => result?.source === 'openverse').length,
          skippedInvalidPrimary
        };
      })
    : payload.sourceStatus;

  return jsonResponse(response, {
    ...payload,
    resultCount: results.length,
    results,
    sourceStatus
  });
}

function isJsonResponse(response) {
  return (response.headers.get('Content-Type') || '').toLowerCase().includes('application/json');
}

function normalizeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function sameUrl(left, right) {
  const normalizedLeft = normalizeHttpsUrl(left);
  const normalizedRight = normalizeHttpsUrl(right);
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
}

function isOpenverseThumbnailUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && /(^|\.)api\.openverse\.org$/i.test(url.hostname)
      && /\/v1\/images\/[^/]+\/thumb\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function classifyInvalidPrimary(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'missing-primary-url';
  if (/^http:\/\//i.test(raw)) return 'insecure-http-primary-url';
  return 'invalid-primary-url';
}

function jsonResponse(original, payload) {
  const headers = new Headers(original.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    status: original.status,
    statusText: original.statusText,
    headers
  });
}

function rebuildResponse(original, body) {
  const headers = new Headers(original.headers);
  headers.delete('Content-Length');
  return new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers
  });
}

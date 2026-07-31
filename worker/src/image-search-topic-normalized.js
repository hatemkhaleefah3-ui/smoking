'use strict';

import {
  handleImageSearchRequest as handleResilientImageSearchRequest,
  ensureImageFeedbackSchema,
  imageSearchErrorResponse,
  rankResults
} from './image-search-resilient.js';

const SEARCH_PATH = '/api/image-search';
const GLYCINE_SUFFIXES = new Map([
  ['chemical-structure', 'chemical structure'],
  ['medical-neurological', 'neurotransmitter'],
  ['nutrition-metabolism', 'metabolism'],
  ['botany', 'plant botany']
]);

export async function handleImageSearchRequest(request, env, url = new URL(request.url)) {
  if (url.pathname !== SEARCH_PATH && url.pathname !== `${SEARCH_PATH}/`) {
    return handleResilientImageSearchRequest(request, env, url);
  }

  const input = await readBody(request.clone());
  const response = await handleResilientImageSearchRequest(request, env, url);
  if (!response || !isJsonResponse(response) || response.status < 200 || response.status >= 300) {
    return response;
  }

  const payload = await response.json();
  if (payload?.requiresTopic !== true || normalizeText(input?.query).toLowerCase() !== 'glycine') {
    return rebuildResponse(response, payload);
  }

  const topics = (Array.isArray(payload.topics) ? payload.topics : []).map((topic) => ({
    ...topic,
    querySuffix: GLYCINE_SUFFIXES.get(topic?.id) || topic?.querySuffix || ''
  }));
  return rebuildResponse(response, { ...payload, topics });
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isJsonResponse(response) {
  return (response.headers.get('Content-Type') || '').toLowerCase().includes('application/json');
}

function rebuildResponse(original, payload) {
  const headers = new Headers(original.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    status: original.status,
    statusText: original.statusText,
    headers
  });
}

export { ensureImageFeedbackSchema, imageSearchErrorResponse, rankResults };

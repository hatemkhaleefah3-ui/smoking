'use strict';

import {
  handleImageSearchRequest as handleDataDrivenImageSearchRequest,
  ensureImageFeedbackSchema,
  imageSearchErrorResponse,
  rankResults
} from './image-search-data-driven.js';

export async function handleImageSearchRequest(request, env, url = new URL(request.url)) {
  const response = await handleDataDrivenImageSearchRequest(request, env, url);
  if (!response || !isJsonResponse(response) || response.status < 200 || response.status >= 300) {
    return response;
  }

  const payload = await response.json();
  if (!Array.isArray(payload.keywordOptions) || payload.keywordOptions.length < 3) {
    return rebuildResponse(response, payload);
  }

  const frequencies = payload.keywordOptions
    .map((option) => Number(option.frequency || 0))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const medianFrequency = median(frequencies);
  const retained = payload.keywordOptions.filter((option) => {
    const frequency = Number(option.frequency || 0);
    const overlap = Number(option.overlapRatio || 0);
    const distinctiveness = Number(option.distinctiveness || 0);
    const dominantModifier = frequency >= medianFrequency * 1.35
      && overlap >= 0.45
      && distinctiveness <= 0.75;
    return !dominantModifier;
  });

  // Never turn a useful disambiguation response into a dead end.
  if (retained.length < 2 || retained.length === payload.keywordOptions.length) {
    return rebuildResponse(response, payload);
  }

  const removed = payload.keywordOptions.length - retained.length;
  return rebuildResponse(response, {
    ...payload,
    keywordOptions: retained,
    keywordExtraction: {
      ...(payload.keywordExtraction || {}),
      genericDropped: Number(payload.keywordExtraction?.genericDropped || 0) + removed,
      dominanceFilterDropped: removed
    }
  });
}

function median(values) {
  if (!values.length) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
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

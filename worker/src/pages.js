import lecturePublisher from './index.js';
import { handleImageAssetRequest } from './image-assets.js';
import { handleEnhancedMediaSearch } from './media-search-enhanced.js';
import { handleRelevantIntentMediaSearch } from './media-search-relevance.js';
import { handleVisualCycleMediaSearch } from './media-search-visual-cycles.js';
import { handleMultiSourceMediaSearch } from './media-search-multisource.js';
import { handleMultiSourceMediaSearchV2 } from './media-search-multisource-v2.js';
import { handleMultiSourceMediaSearchV3 } from './media-search-multisource-v3.generated.js';
import { handleMultiSourceMediaSearchV4 } from './media-search-multisource-v4.js';
import { handleLiveMediaDiagnostics } from './live-media-diagnostics.js';
import { handlePdfExtractionRequest } from './pdf-routes.js';

const MEDIA_SEARCH_HANDLERS = [
  ['multi-source-v4', handleMultiSourceMediaSearchV4],
  ['multi-source-v3', handleMultiSourceMediaSearchV3],
  ['multi-source-v2', handleMultiSourceMediaSearchV2],
  ['multi-source-legacy', handleMultiSourceMediaSearch],
  ['visual-cycle', handleVisualCycleMediaSearch],
  ['relevance', handleRelevantIntentMediaSearch],
  ['enhanced-wikimedia', handleEnhancedMediaSearch]
];

export async function routeMediaSearch(request, env, trace = []) {
  for (const [name, handler] of MEDIA_SEARCH_HANDLERS) {
    const startedAt = Date.now();
    try {
      const response = await handler(request, env);
      trace.push({
        handler: name,
        returnedResponse: Boolean(response),
        status: response?.status ?? null,
        durationMs: Date.now() - startedAt
      });
      if (response) return response;
    } catch (error) {
      trace.push({
        handler: name,
        returnedResponse: false,
        status: null,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  return Response.json({ error: 'No media-search handler accepted the request.' }, { status: 500 });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const diagnosticResponse = await handleLiveMediaDiagnostics(request, env, url, routeMediaSearch);
    if (diagnosticResponse) return diagnosticResponse;
    if (url.pathname === '/api/search' || url.pathname === '/api/search/') {
      return routeMediaSearch(request, env);
    }
    const pdfResponse = await handlePdfExtractionRequest(request, env, url);
    if (pdfResponse) return pdfResponse;
    const imageResponse = await handleImageAssetRequest(request, env, url);
    if (imageResponse) return imageResponse;
    return lecturePublisher.fetch(request, env, context);
  }
};

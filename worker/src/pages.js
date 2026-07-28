import lecturePublisher from './index.js';
import { handleImageAssetRequest } from './image-assets.js';
import { handleEnhancedMediaSearch } from './media-search-enhanced.js';
import { handleRelevantIntentMediaSearch } from './media-search-relevance.js';
import { handlePdfExtractionRequest } from './pdf-routes.js';

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === '/api/search' || url.pathname === '/api/search/') {
      const intentResponse = await handleRelevantIntentMediaSearch(request, env);
      if (intentResponse) return intentResponse;
      return handleEnhancedMediaSearch(request, env);
    }
    const pdfResponse = await handlePdfExtractionRequest(request, env, url);
    if (pdfResponse) return pdfResponse;
    const imageResponse = await handleImageAssetRequest(request, env, url);
    if (imageResponse) return imageResponse;
    return lecturePublisher.fetch(request, env, context);
  }
};
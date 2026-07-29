import lecturePublisher from './index.js';
import { handleImageAssetRequest } from './image-assets.js';
import { handleEnhancedMediaSearch } from './media-search-enhanced.js';
import { handleRelevantIntentMediaSearch } from './media-search-relevance.js';
import { handleVisualCycleMediaSearch } from './media-search-visual-cycles.js';
import { handleMultiSourceMediaSearch } from './media-search-multisource.js';
import { handleMultiSourceMediaSearchV2 } from './media-search-multisource-v2.js';
import { handleMultiSourceMediaSearchV3 } from './media-search-multisource-v3.generated.js';
import { handleMultiSourceMediaSearchV4 } from './media-search-multisource-v4.js';
import { handlePdfExtractionRequest } from './pdf-routes.js';

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === '/api/search' || url.pathname === '/api/search/') {
      const strictBalancedResponse = await handleMultiSourceMediaSearchV4(request, env);
      if (strictBalancedResponse) return strictBalancedResponse;
      const diverseMultiSourceResponse = await handleMultiSourceMediaSearchV3(request, env);
      if (diverseMultiSourceResponse) return diverseMultiSourceResponse;
      const correctedMultiSourceResponse = await handleMultiSourceMediaSearchV2(request, env);
      if (correctedMultiSourceResponse) return correctedMultiSourceResponse;
      const multiSourceResponse = await handleMultiSourceMediaSearch(request, env);
      if (multiSourceResponse) return multiSourceResponse;
      const visualCycleResponse = await handleVisualCycleMediaSearch(request, env);
      if (visualCycleResponse) return visualCycleResponse;
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

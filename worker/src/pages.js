import lecturePublisher from './index.js';
import { handleMediaSearch } from './media-search.js';

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === '/api/search' || url.pathname === '/api/search/') {
      return handleMediaSearch(request, env);
    }
    return lecturePublisher.fetch(request, env, context);
  }
};

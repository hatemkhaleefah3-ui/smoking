import { handleIntentMediaSearch as handleOrderedIntentMediaSearch } from './media-search-intent.js';

export async function handleRelevantIntentMediaSearch(request, env) {
  return handleOrderedIntentMediaSearch(request, env);
}

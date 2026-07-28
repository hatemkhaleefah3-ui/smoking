import { handleMediaSearch } from '../../worker/src/media-search.js';

export function onRequest(context) {
  return handleMediaSearch(context.request, context.env);
}

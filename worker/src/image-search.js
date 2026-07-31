import {
  handleImageSearchRequest,
  ensureImageFeedbackSchema,
  imageSearchErrorResponse as dataDrivenErrorResponse,
  rankResults
} from './image-search-data-driven.js';

export { handleImageSearchRequest, ensureImageFeedbackSchema, rankResults };

export function imageSearchErrorResponse(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'The adaptive image search request is invalid.' },
      {
        status,
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        }
      }
    );
  }
  return dataDrivenErrorResponse(error);
}

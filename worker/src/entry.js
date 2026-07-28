import lectureWorker from './index.js';
import { createPdfExtraction, downloadPdfExtraction } from './pdf-extractor.js';
import { configureMupdfAssets } from './mupdf-loader.js';
import { ensurePdfExtractionSchema } from './pdf-schema.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/pdf-extractions' && request.method === 'POST') {
        assertSameOrigin(request, url);
        const extractionEnv = pdfExtractionEnv(env);
        configureMupdfAssets(env.ASSETS);
        await ensurePdfExtractionSchema(extractionEnv, HttpError);
        return createPdfExtraction(request, extractionEnv, url, { HttpError, json });
      }

      const downloadMatch = url.pathname.match(/^\/api\/pdf-extractions\/([0-9a-f-]{36})\/download$/i);
      if (downloadMatch && request.method === 'GET') {
        const extractionEnv = pdfExtractionEnv(env);
        await ensurePdfExtractionSchema(extractionEnv, HttpError);
        return downloadPdfExtraction(downloadMatch[1], extractionEnv, { HttpError });
      }

      return lectureWorker.fetch(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'pdf_extraction_request_error',
        method: request.method,
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error)
      }));
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: 'Unexpected server error.' }, 500);
    }
  }
};

function pdfExtractionEnv(env) {
  const bucket = env.PDF_EXTRACTIONS || env.LECTURES;
  if (!bucket) {
    throw new HttpError(500, 'An R2 storage binding is not configured for this environment.');
  }
  return Object.assign(Object.create(env), { PDF_EXTRACTIONS: bucket });
}

function assertSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin mutation is not allowed.');
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

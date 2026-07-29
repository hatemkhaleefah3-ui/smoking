import { createPdfExtraction, downloadPdfExtraction } from './pdf-extractor.js';
import { ensurePdfExtractionSchema } from './pdf-schema.js';

export async function handlePdfExtractionRequest(request, env, url = new URL(request.url)) {
  const isCreate = url.pathname === '/api/pdf-extractions' && request.method === 'POST';
  const downloadMatch = url.pathname.match(/^\/api\/pdf-extractions\/([0-9a-f-]{36})\/download$/i);
  const isDownload = Boolean(downloadMatch && request.method === 'GET');
  if (!isCreate && !isDownload) return null;

  try {
    const extractionEnv = pdfExtractionEnv(env);
    await ensurePdfExtractionSchema(extractionEnv, HttpError);

    if (isCreate) {
      assertSameOrigin(request, url);
      return await createPdfExtraction(request, extractionEnv, url, { HttpError, json });
    }
    return await downloadPdfExtraction(downloadMatch[1], extractionEnv, { HttpError });
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

function pdfExtractionEnv(env) {
  const bucket = env.PDF_EXTRACTIONS || env.LECTURES;
  if (!bucket) throw new HttpError(500, 'An R2 storage binding is not configured for this environment.');
  if (!env.DB) throw new HttpError(500, 'The D1 database binding “DB” is not configured for this environment.');
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

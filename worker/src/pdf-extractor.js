const DEFAULT_MAX_EXTRACTED_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_REQUESTED_IMAGES = 500;
const MAX_REQUESTED_JSON_BYTES = 16 * 1024;
const MAX_FILENAME_BYTES = 1024;

export async function createPdfExtraction(request, env, url, { HttpError, json }) {
  if (!request.body) throw new HttpError(400, 'The extracted result upload is empty.');

  const maximumResultBytes = integerEnv(env.MAX_EXTRACTED_IMAGE_BYTES, DEFAULT_MAX_EXTRACTED_IMAGE_BYTES);
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength <= 0) throw new HttpError(411, 'The extracted result size is required.');
  if (declaredLength > maximumResultBytes) {
    throw new HttpError(413, `The extracted result exceeds the ${formatMegabytes(maximumResultBytes)} MB limit.`);
  }

  const imageCount = Number(request.headers.get('X-PDF-Image-Count'));
  if (!Number.isSafeInteger(imageCount) || imageCount < 1 || imageCount > MAX_REQUESTED_IMAGES) {
    throw new HttpError(400, `The image count must be an integer between 1 and ${MAX_REQUESTED_IMAGES}.`);
  }

  const sourceFilename = cleanSourceFilename(decodeHeader(
    request.headers.get('X-PDF-Source-Filename'),
    'The source filename is invalid.',
    HttpError
  ));
  const requestedJson = normalizeRequestedJson(decodeHeader(
    request.headers.get('X-PDF-Requested-Json'),
    'The requested JSON is invalid.',
    HttpError,
    true
  ), HttpError);

  const artifactType = classifyArtifact(
    request.headers.get('Content-Type') || '',
    imageCount,
    HttpError
  );
  const artifactFilename = decodeHeader(
    request.headers.get('X-PDF-Artifact-Filename'),
    'The output filename is invalid.',
    HttpError
  );
  const outputFilename = cleanOutputFilename(artifactFilename, sourceFilename, artifactType.extension);
  const id = crypto.randomUUID();
  const outputKey = `pdf-extractions/${id}/download.${artifactType.extension}`;
  const createdAt = new Date().toISOString();

  let storedObject;
  try {
    storedObject = await env.PDF_EXTRACTIONS.put(outputKey, request.body, {
      httpMetadata: { contentType: artifactType.contentType },
      customMetadata: {
        sourceFilename,
        imageCount: String(imageCount),
        createdAt
      }
    });

    const outputSizeBytes = storedObject?.size || declaredLength;
    await env.DB.prepare(`
      INSERT INTO pdf_extraction_jobs (
        id, source_filename, requested_json, image_count,
        output_r2_key, output_filename, output_content_type, output_size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      sourceFilename,
      requestedJson,
      imageCount,
      outputKey,
      outputFilename,
      artifactType.contentType,
      outputSizeBytes,
      createdAt
    ).run();
  } catch (error) {
    try { await env.PDF_EXTRACTIONS.delete(outputKey); }
    catch { /* best-effort cleanup */ }
    console.error(JSON.stringify({
      event: 'pdf_extraction_artifact_store_failed',
      message: error instanceof Error ? error.message : String(error)
    }));
    throw new HttpError(500, 'The extracted result could not be stored. Check the R2 and DB bindings, then retry.');
  }

  const outputSizeBytes = storedObject?.size || declaredLength;
  console.log(JSON.stringify({
    event: 'pdf_images_stored',
    id,
    sourceFilename,
    requestedJson,
    imageCount,
    outputSizeBytes
  }));

  return json({
    jobId: id,
    imageCount,
    filename: outputFilename,
    contentType: artifactType.contentType,
    downloadUrl: `${url.origin}/api/pdf-extractions/${id}/download`
  }, 201);
}

export async function downloadPdfExtraction(id, env, { HttpError }) {
  const record = await env.DB.prepare(`
    SELECT output_r2_key, output_filename, output_content_type
    FROM pdf_extraction_jobs
    WHERE id = ?
  `).bind(id).first();
  if (!record) throw new HttpError(404, 'Extraction result not found.');

  const object = await env.PDF_EXTRACTIONS.get(record.output_r2_key);
  if (!object?.body) throw new HttpError(404, 'Extraction result is no longer available.');

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': record.output_content_type,
      'Content-Disposition': contentDisposition(record.output_filename),
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function classifyArtifact(contentTypeValue, imageCount, HttpError) {
  const contentType = String(contentTypeValue).split(';', 1)[0].trim().toLowerCase();
  if (contentType === 'image/png') {
    if (imageCount !== 1) throw new HttpError(400, 'A PNG artifact must represent exactly one extracted image.');
    return { contentType: 'image/png', extension: 'png' };
  }
  if (contentType === 'application/zip' || contentType === 'application/x-zip-compressed') {
    return { contentType: 'application/zip', extension: 'zip' };
  }
  throw new HttpError(415, 'The extracted artifact must be a PNG or ZIP file.');
}

function decodeHeader(value, errorMessage, HttpError, allowEmpty = false) {
  const encoded = String(value || '').trim();
  if (!encoded) {
    if (allowEmpty) return '';
    throw new HttpError(400, errorMessage);
  }
  if (encoded.length > MAX_FILENAME_BYTES * 2 && !allowEmpty) throw new HttpError(400, errorMessage);
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new HttpError(400, errorMessage);
  }
}

function normalizeRequestedJson(value, HttpError) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (new TextEncoder().encode(text).byteLength > MAX_REQUESTED_JSON_BYTES) {
    throw new HttpError(400, 'The requested JSON is too large.');
  }
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed);
  } catch {
    throw new HttpError(400, 'The requested JSON is invalid.');
  }
}

function cleanSourceFilename(value) {
  const cleaned = String(value || 'document.pdf').replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim().slice(0, 180);
  return cleaned || 'document.pdf';
}

function cleanOutputFilename(value, sourceFilename, extension) {
  const cleaned = String(value || '').replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim().slice(0, 200);
  if (cleaned.toLowerCase().endsWith(`.${extension}`)) return cleaned;
  const base = filenameBase(sourceFilename);
  return extension === 'png' ? `${base}-image.png` : `${base}-images.zip`;
}

function filenameBase(filename) {
  const withoutExtension = filename.replace(/\.pdf$/i, '');
  const safe = withoutExtension.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return safe || 'pdf';
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function integerEnv(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function formatMegabytes(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

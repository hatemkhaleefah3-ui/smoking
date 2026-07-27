import { zipSync } from 'fflate';
import { loadMupdf } from './mupdf-loader.js';

const DEFAULT_MAX_PDF_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_REQUESTED_IMAGES = 500;

export async function createPdfExtraction(request, env, url, { HttpError, json }) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(415, 'Upload the PDF as multipart form data.');
  }

  const maximumPdfBytes = integerEnv(env.MAX_PDF_BYTES, DEFAULT_MAX_PDF_BYTES);
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > maximumPdfBytes + 1024 * 1024) {
    throw new HttpError(413, `PDF exceeds the ${formatMegabytes(maximumPdfBytes)} MB limit.`);
  }

  let form;
  try { form = await request.formData(); }
  catch { throw new HttpError(400, 'The PDF upload could not be read.'); }

  const pdf = form.get('pdf');
  if (!(pdf instanceof File)) throw new HttpError(400, 'A PDF file is required.');
  if (pdf.size === 0) throw new HttpError(400, 'The uploaded PDF is empty.');
  if (pdf.size > maximumPdfBytes) throw new HttpError(413, `PDF exceeds the ${formatMegabytes(maximumPdfBytes)} MB limit.`);
  if (!(pdf.type === 'application/pdf' || pdf.name.toLowerCase().endsWith('.pdf'))) {
    throw new HttpError(415, 'The uploaded file must be a PDF.');
  }

  const imagesField = form.get('images');
  if (imagesField instanceof File) throw new HttpError(400, 'The images field must be JSON text.');
  const requestSelection = parseRequestedImages(typeof imagesField === 'string' ? imagesField : '', HttpError);
  const id = crypto.randomUUID();
  const prefix = `pdf-extractions/${id}`;
  const sourceKey = `${prefix}/source.pdf`;
  const storedKeys = new Set();
  const createdAt = new Date().toISOString();
  const sourceFilename = cleanSourceFilename(pdf.name);
  const baseFilename = filenameBase(sourceFilename);

  try {
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
    await env.PDF_EXTRACTIONS.put(sourceKey, pdfBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { sourceFilename }
    });
    storedKeys.add(sourceKey);

    const mupdf = await loadMupdf();
    let extracted;
    try {
      extracted = extractImages(mupdf, pdfBytes, requestSelection.selectors, HttpError);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const detail = safeErrorMessage(error);
      throw new HttpError(400, detail ? `Could not read or extract images from this PDF: ${detail}` : 'Could not read or extract images from this PDF.');
    }

    if (extracted.length === 0) throw new HttpError(422, 'This PDF has no extractable embedded images.');

    const maximumExtractedBytes = integerEnv(env.MAX_EXTRACTED_IMAGE_BYTES, DEFAULT_MAX_EXTRACTED_IMAGE_BYTES);
    let totalBytes = 0;
    for (const item of extracted) {
      totalBytes += item.bytes.byteLength;
      if (totalBytes > maximumExtractedBytes) {
        throw new HttpError(413, `Extracted images exceed the ${formatMegabytes(maximumExtractedBytes)} MB result limit.`);
      }
      item.r2Key = `${prefix}/images/${item.filename}`;
      await env.PDF_EXTRACTIONS.put(item.r2Key, item.bytes, {
        httpMetadata: { contentType: 'image/png' },
        customMetadata: { page: String(item.page), position: String(item.position) }
      });
      storedKeys.add(item.r2Key);
    }

    let outputKey;
    let outputFilename;
    let outputContentType;
    let outputSizeBytes;

    if (extracted.length === 1) {
      const item = extracted[0];
      outputKey = item.r2Key;
      outputFilename = `${baseFilename}-${item.filename}`;
      outputContentType = 'image/png';
      outputSizeBytes = item.bytes.byteLength;
    } else {
      const zipEntries = Object.fromEntries(extracted.map((item) => [item.filename, item.bytes]));
      const archive = zipSync(zipEntries, { level: 6 });
      if (archive.byteLength > maximumExtractedBytes) {
        throw new HttpError(413, `The ZIP result exceeds the ${formatMegabytes(maximumExtractedBytes)} MB result limit.`);
      }
      outputKey = `${prefix}/download.zip`;
      outputFilename = `${baseFilename}-images.zip`;
      outputContentType = 'application/zip';
      outputSizeBytes = archive.byteLength;
      await env.PDF_EXTRACTIONS.put(outputKey, archive, {
        httpMetadata: { contentType: outputContentType },
        customMetadata: { imageCount: String(extracted.length), sourceFilename }
      });
      storedKeys.add(outputKey);
    }

    await env.DB.prepare(`
      INSERT INTO pdf_extraction_jobs (
        id, source_filename, requested_json, image_count,
        output_r2_key, output_filename, output_content_type, output_size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      sourceFilename,
      requestSelection.requestedJson,
      extracted.length,
      outputKey,
      outputFilename,
      outputContentType,
      outputSizeBytes,
      createdAt
    ).run();

    const temporaryKeys = [sourceKey];
    if (extracted.length > 1) temporaryKeys.push(...extracted.map((item) => item.r2Key));
    await deleteKeysQuietly(env.PDF_EXTRACTIONS, temporaryKeys);
    for (const key of temporaryKeys) storedKeys.delete(key);

    console.log(JSON.stringify({
      event: 'pdf_images_extracted',
      id,
      sourceFilename,
      requestedJson: requestSelection.requestedJson,
      imageCount: extracted.length,
      outputSizeBytes
    }));

    return json({
      jobId: id,
      imageCount: extracted.length,
      filename: outputFilename,
      contentType: outputContentType,
      downloadUrl: `${url.origin}/api/pdf-extractions/${id}/download`
    }, 201);
  } catch (error) {
    await deleteKeysQuietly(env.PDF_EXTRACTIONS, [...storedKeys]);
    throw error;
  }
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

function extractImages(mupdf, pdfBytes, selectors, HttpError) {
  let document;
  const output = [];
  try {
    document = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    const pageCount = document.countPages();

    if (selectors) {
      for (const selector of selectors) {
        if (selector.page > pageCount) {
          throw new HttpError(400, `Requested page ${selector.page} does not exist; this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
        }
      }
      const pages = groupSelectorsByPage(selectors);
      for (const [pageNumber, positions] of pages) {
        output.push(...extractPageImages(mupdf, document, pageNumber, positions, HttpError));
      }
    } else {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        output.push(...extractPageImages(mupdf, document, pageNumber, null, HttpError));
      }
    }
    return output;
  } finally {
    safeDestroy(document);
  }
}

function extractPageImages(mupdf, document, pageNumber, requestedPositions, HttpError) {
  let page;
  try {
    page = document.loadPage(pageNumber - 1);
    const imageStack = page.getImages() || [];
    const positions = requestedPositions || imageStack.map((_, index) => index + 1);
    const extracted = [];

    for (const position of positions) {
      if (position > imageStack.length) {
        throw new HttpError(400, `Requested image at page ${pageNumber}, position ${position} does not exist; page ${pageNumber} has ${imageStack.length} embedded image${imageStack.length === 1 ? '' : 's'}.`);
      }
      const stackEntry = imageStack[position - 1];
      const image = stackEntry?.image || stackEntry;
      if (!image || typeof image.toPixmap !== 'function') {
        throw new HttpError(422, `The image at page ${pageNumber}, position ${position} could not be decoded.`);
      }
      extracted.push({
        page: pageNumber,
        position,
        filename: `page-${pageNumber}-image-${position}.png`,
        bytes: encodeImageAsPng(mupdf, image)
      });
      safeDestroy(image);
    }
    return extracted;
  } finally {
    safeDestroy(page);
  }
}

function encodeImageAsPng(mupdf, image) {
  let pixmap;
  let converted;
  let encoded;
  try {
    pixmap = image.toPixmap();
    try {
      encoded = pixmap.asPNG();
    } catch (error) {
      if (!pixmap.getColorSpace?.() || !mupdf.ColorSpace?.DeviceRGB) throw error;
      converted = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, Boolean(pixmap.getAlpha?.()));
      encoded = converted.asPNG();
    }
    return copyBytes(encoded);
  } finally {
    safeDestroy(encoded);
    safeDestroy(converted);
    safeDestroy(pixmap);
  }
}

function parseRequestedImages(value, HttpError) {
  const trimmed = value.trim();
  if (!trimmed) return { selectors: null, requestedJson: null };

  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { throw new HttpError(400, 'The images field is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'The images field must be a JSON object.');
  }
  if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
    throw new HttpError(400, 'The images field must contain a non-empty images array, or be omitted to extract all images.');
  }
  if (parsed.images.length > MAX_REQUESTED_IMAGES) {
    throw new HttpError(400, `A maximum of ${MAX_REQUESTED_IMAGES} images can be requested at once.`);
  }

  const selectors = [];
  const seen = new Set();
  for (const item of parsed.images) {
    const page = Number(item?.page);
    const position = Number(item?.position);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(position) || position < 1) {
      throw new HttpError(400, 'Every requested image must have positive integer page and position values.');
    }
    const key = `${page}:${position}`;
    if (!seen.has(key)) {
      seen.add(key);
      selectors.push({ page, position });
    }
  }
  return { selectors, requestedJson: JSON.stringify({ images: selectors }) };
}

function groupSelectorsByPage(selectors) {
  const pages = new Map();
  for (const selector of selectors) {
    if (!pages.has(selector.page)) pages.set(selector.page, []);
    pages.get(selector.page).push(selector.position);
  }
  return [...pages.entries()].sort((left, right) => left[0] - right[0]).map(([page, positions]) => [page, positions.sort((a, b) => a - b)]);
}

function copyBytes(buffer) {
  if (buffer instanceof Uint8Array) return Uint8Array.from(buffer);
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer.slice(0));
  if (typeof buffer?.asUint8Array === 'function') return Uint8Array.from(buffer.asUint8Array());
  throw new Error('MuPDF returned an unsupported image buffer.');
}

async function deleteKeysQuietly(bucket, keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  for (let index = 0; index < unique.length; index += 1000) {
    try { await bucket.delete(unique.slice(index, index + 1000)); }
    catch (error) {
      console.warn(JSON.stringify({ event: 'pdf_extraction_cleanup_failed', message: safeErrorMessage(error) }));
    }
  }
}

function safeDestroy(value) {
  try { value?.destroy?.(); } catch { /* best effort MuPDF cleanup */ }
}

function cleanSourceFilename(value) {
  const cleaned = String(value || 'document.pdf').replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim().slice(0, 180);
  return cleaned || 'document.pdf';
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

function safeErrorMessage(error) {
  return (error instanceof Error ? error.message : String(error || '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
}

function integerEnv(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function formatMegabytes(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

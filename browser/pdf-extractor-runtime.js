import { zipSync } from 'fflate';

const MAX_REQUESTED_IMAGES = 500;
let mupdfPromise = null;

export async function extractPdfArtifact(file, rawSelectors = '') {
  if (!(file instanceof File)) throw new Error('A PDF file is required.');

  const requestSelection = parseRequestedImages(rawSelectors);
  const pdfBytes = new Uint8Array(await file.arrayBuffer());
  const mupdf = await loadMupdf();

  let extracted;
  try {
    extracted = extractImages(mupdf, pdfBytes, requestSelection.selectors);
  } catch (error) {
    const detail = safeErrorMessage(error);
    throw new Error(detail ? `Could not read or extract images from this PDF: ${detail}` : 'Could not read or extract images from this PDF.');
  }

  if (extracted.length === 0) {
    throw new Error('This PDF has no extractable embedded images.');
  }

  const baseFilename = filenameBase(file.name);
  if (extracted.length === 1) {
    const item = extracted[0];
    const filename = `${baseFilename}-${item.filename}`;
    return {
      blob: new Blob([item.bytes], { type: 'image/png' }),
      filename,
      contentType: 'image/png',
      imageCount: 1,
      requestedJson: requestSelection.requestedJson
    };
  }

  const zipEntries = Object.fromEntries(extracted.map((item) => [item.filename, item.bytes]));
  const archive = zipSync(zipEntries, { level: 6 });
  return {
    blob: new Blob([archive], { type: 'application/zip' }),
    filename: `${baseFilename}-images.zip`,
    contentType: 'application/zip',
    imageCount: extracted.length,
    requestedJson: requestSelection.requestedJson
  };
}

async function loadMupdf() {
  if (!mupdfPromise) {
    mupdfPromise = initializeMupdf().catch((error) => {
      mupdfPromise = null;
      throw error;
    });
  }
  return mupdfPromise;
}

async function initializeMupdf() {
  const response = await fetch('/vendor/mupdf-wasm.wasm', { cache: 'force-cache' });
  if (!response.ok) throw new Error(`MuPDF WASM asset could not be loaded (${response.status}).`);

  const wasmBinary = new Uint8Array(await response.arrayBuffer());
  globalThis.$libmupdf_wasm_Module = { wasmBinary };
  try {
    const module = await import('mupdf');
    return module.default || module;
  } finally {
    delete globalThis.$libmupdf_wasm_Module;
  }
}

function extractImages(mupdf, pdfBytes, selectors) {
  let document;
  const output = [];
  try {
    document = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    const pageCount = document.countPages();

    if (selectors) {
      for (const selector of selectors) {
        if (selector.page > pageCount) {
          throw new Error(`Requested page ${selector.page} does not exist; this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
        }
      }
      const pages = groupSelectorsByPage(selectors);
      for (const [pageNumber, positions] of pages) {
        output.push(...extractPageImages(mupdf, document, pageNumber, positions));
      }
    } else {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        output.push(...extractPageImages(mupdf, document, pageNumber, null));
      }
    }
    return output;
  } finally {
    safeDestroy(document);
  }
}

function extractPageImages(mupdf, document, pageNumber, requestedPositions) {
  let page;
  let device;
  try {
    page = document.loadPage(pageNumber - 1);
    const requested = requestedPositions ? new Set(requestedPositions) : null;
    const extracted = [];
    let position = 0;

    device = new mupdf.Device({
      fillImage(image) {
        position += 1;
        if (!requested || requested.has(position)) {
          extracted.push({
            page: pageNumber,
            position,
            filename: `page-${pageNumber}-image-${position}.png`,
            bytes: encodeImageAsPng(mupdf, image)
          });
        }
      }
    });

    page.runPageContents(device, mupdf.Matrix.identity);

    if (requestedPositions) {
      const missing = requestedPositions.find((candidate) => candidate > position);
      if (missing) {
        throw new Error(`Requested image at page ${pageNumber}, position ${missing} does not exist; page ${pageNumber} has ${position} embedded image${position === 1 ? '' : 's'}.`);
      }
    }

    return extracted;
  } finally {
    safeDestroy(device);
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

function parseRequestedImages(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { selectors: null, requestedJson: null };

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('The images field is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The images field must be a JSON object.');
  }
  if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
    throw new Error('The images field must contain a non-empty images array, or be left empty to extract all images.');
  }
  if (parsed.images.length > MAX_REQUESTED_IMAGES) {
    throw new Error(`A maximum of ${MAX_REQUESTED_IMAGES} images can be requested at once.`);
  }

  const selectors = [];
  const seen = new Set();
  for (const item of parsed.images) {
    const page = Number(item?.page);
    const position = Number(item?.position);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(position) || position < 1) {
      throw new Error('Every requested image must have positive integer page and position values.');
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
  return [...pages.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([page, positions]) => [page, positions.sort((a, b) => a - b)]);
}

function copyBytes(buffer) {
  if (buffer instanceof Uint8Array) return Uint8Array.from(buffer);
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer.slice(0));
  if (typeof buffer?.asUint8Array === 'function') return Uint8Array.from(buffer.asUint8Array());
  throw new Error('MuPDF returned an unsupported image buffer.');
}

function safeDestroy(value) {
  try { value?.destroy?.(); } catch { /* best-effort MuPDF cleanup */ }
}

function filenameBase(filename) {
  const withoutExtension = String(filename || 'pdf').replace(/\.pdf$/i, '');
  const safe = withoutExtension.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return safe || 'pdf';
}

function safeErrorMessage(error) {
  return (error instanceof Error ? error.message : String(error || '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 220);
}

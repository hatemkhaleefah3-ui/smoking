const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_IMAGE_UPLOAD_BYTES_PER_HOUR = 100 * 1024 * 1024;
const IMAGE_UPLOAD_LIMIT_PER_HOUR = 60;
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif']
]);
let schemaPromise = null;

export async function handleImageAssetRequest(request, env, url) {
  if (url.pathname === '/api/images' && request.method === 'POST') {
    return uploadImage(request, env, url);
  }

  const imageMatch = url.pathname.match(/^\/api\/images\/([0-9a-f-]{36})\.(jpg|png|webp|gif|avif)$/i);
  if (imageMatch && request.method === 'GET') {
    return getImage(imageMatch[1], imageMatch[2].toLowerCase(), env);
  }

  return null;
}

async function uploadImage(request, env, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'Cross-origin mutation is not allowed.' }, 403);
  if (!env.LECTURES) return json({ error: 'R2 image storage is not configured for this environment.' }, 500);
  if (!env.DB) return json({ error: 'D1 rate-limit storage is not configured for this environment.' }, 500);

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return json({ error: 'Image uploads must use multipart form data.' }, 415);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'The image upload could not be read.' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return json({ error: 'Choose an image file.' }, 400);
  const type = String(file.type || '').toLowerCase();
  const extension = IMAGE_TYPES.get(type);
  if (!extension) return json({ error: 'Use a JPEG, PNG, WebP, GIF or AVIF image.' }, 415);

  const maximumBytes = positiveInteger(env.MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES);
  const size = Number(file.size || 0);
  if (!Number.isSafeInteger(size) || size <= 0) return json({ error: 'The selected image is empty.' }, 400);
  if (size > maximumBytes) return json({ error: `Each image must be ${formatMegabytes(maximumBytes)} MB or smaller.` }, 413);

  await ensureImageRateSchema(env.DB);
  const ip = clientIp(request);
  const hourlyByteLimit = positiveInteger(env.IMAGE_UPLOAD_BYTES_PER_HOUR, DEFAULT_IMAGE_UPLOAD_BYTES_PER_HOUR);
  const rateError = await checkImageUploadRate(env.DB, ip, size, hourlyByteLimit);
  if (rateError) return json({ error: rateError }, 429);

  const id = crypto.randomUUID();
  const key = `images/${id}.${extension}`;
  const label = cleanMetadata(form.get('label'), 200);
  const originalName = cleanMetadata(file.name, 200);
  const bytes = await file.arrayBuffer();
  const object = await env.LECTURES.put(key, bytes, {
    httpMetadata: {
      contentType: type,
      cacheControl: 'public, max-age=31536000, immutable'
    },
    customMetadata: {
      label,
      originalName,
      uploadedAt: new Date().toISOString()
    }
  });
  if (!object) return json({ error: 'The image could not be stored.' }, 500);

  console.log(JSON.stringify({ event: 'lecture_image_uploaded', id, contentType: type, sizeBytes: object.size }));
  return json({
    id,
    url: `${url.origin}/api/images/${id}.${extension}`,
    label,
    contentType: type,
    sizeBytes: object.size
  }, 201);
}

async function getImage(id, extension, env) {
  if (!env.LECTURES) return json({ error: 'R2 image storage is not configured for this environment.' }, 500);
  const object = await env.LECTURES.get(`images/${id}.${extension}`);
  if (!object || !object.body) return json({ error: 'Image not found.' }, 404);

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === 'function') object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

async function ensureImageRateSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.prepare(`CREATE TABLE IF NOT EXISTS image_upload_rate_limits (
      ip TEXT PRIMARY KEY,
      window_started INTEGER NOT NULL,
      upload_count INTEGER NOT NULL DEFAULT 0,
      upload_bytes INTEGER NOT NULL DEFAULT 0
    )`).run().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function checkImageUploadRate(db, ip, bytes, byteLimit) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % 3600);
  const row = await db.prepare(
    'SELECT window_started, upload_count, upload_bytes FROM image_upload_rate_limits WHERE ip = ?'
  ).bind(ip).first();

  if (!row || Number(row.window_started) !== windowStart) {
    await db.prepare(`
      INSERT INTO image_upload_rate_limits (ip, window_started, upload_count, upload_bytes)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(ip) DO UPDATE SET
        window_started = excluded.window_started,
        upload_count = 1,
        upload_bytes = excluded.upload_bytes
    `).bind(ip, windowStart, bytes).run();
    return '';
  }

  if (Number(row.upload_count) >= IMAGE_UPLOAD_LIMIT_PER_HOUR) {
    return 'Image upload limit reached. Try again later.';
  }
  if (Number(row.upload_bytes) + bytes > byteLimit) {
    return 'Hourly image upload size limit reached. Try again later.';
  }

  await db.prepare(`
    UPDATE image_upload_rate_limits
    SET upload_count = upload_count + 1, upload_bytes = upload_bytes + ?
    WHERE ip = ?
  `).bind(bytes, ip).run();
  return '';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function cleanMetadata(value, maximumLength) {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function clientIp(request) {
  return (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function formatMegabytes(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

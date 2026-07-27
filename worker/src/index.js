const DESIGNS = new Set(['classic', 'enhanced', 'editorial']);
const SCHEMA_VERSIONS = new Set(['1.0', '2.1']);
const SESSION_COOKIE = 'lecture_admin';
const SESSION_SECONDS = 8 * 60 * 60;
const DEFAULT_MAX_LECTURE_BYTES = 25 * 1024 * 1024;
const DEFAULT_ALLOWANCE_BYTES = 10_000_000_000;
const PUBLISH_LIMIT_PER_HOUR = 20;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;
let schemaPromise = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && /^\/lecture\/[0-9a-f-]{36}\/?$/i.test(url.pathname)) {
        return serveAsset(env, request, '/lecture');
      }
      if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
        return serveAsset(env, request, '/admin');
      }

      if (url.pathname.startsWith('/api/')) await ensureDatabase(env);

      if (url.pathname === '/api/health' && request.method === 'GET') {
        const storageReady = Boolean(env.LECTURES);
        const adminReady = Boolean(env.ADMIN_PASSWORD && env.SESSION_SECRET);
        return json({
          ok: storageReady && adminReady,
          databaseReady: true,
          storageReady,
          adminSecretsReady: adminReady
        }, storageReady && adminReady ? 200 : 503);
      }

      if (url.pathname === '/api/lectures' && request.method === 'POST') {
        assertSameOrigin(request, url);
        requireLectureStorage(env);
        return publishLecture(request, env, url);
      }

      const publicLectureMatch = url.pathname.match(/^\/api\/lectures\/([0-9a-f-]{36})$/i);
      if (publicLectureMatch && request.method === 'GET') {
        requireLectureStorage(env);
        return getLecture(publicLectureMatch[1], env);
      }

      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        assertSameOrigin(request, url);
        return adminLogin(request, env);
      }
      if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
        assertSameOrigin(request, url);
        return adminLogout();
      }
      if (url.pathname === '/api/admin/session' && request.method === 'GET') {
        return await requireAdmin(request, env) ? json({ authenticated: true }) : json({ authenticated: false }, 401);
      }

      if (url.pathname.startsWith('/api/admin/')) {
        assertSameOrigin(request, url);
        if (!await requireAdmin(request, env)) return json({ error: 'Administrator session required.' }, 401);

        if (url.pathname === '/api/admin/storage' && request.method === 'GET') return adminStorage(env);
        if (url.pathname === '/api/admin/lectures' && request.method === 'GET') return adminLectures(env, url);
        if (url.pathname === '/api/admin/cleanup' && request.method === 'POST') {
          requireLectureStorage(env);
          return adminCleanup(request, env);
        }

        const deleteMatch = url.pathname.match(/^\/api\/admin\/lectures\/([0-9a-f-]{36})$/i);
        if (deleteMatch && request.method === 'DELETE') {
          requireLectureStorage(env);
          return adminDeleteLecture(deleteMatch[1], env);
        }
      }

      if (url.pathname.startsWith('/api/')) return json({ error: 'API route not found.' }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', method: request.method, path: url.pathname, message: error instanceof Error ? error.message : String(error) }));
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: 'Unexpected server error.' }, 500);
    }
  }
};

async function ensureDatabase(env) {
  if (!env.DB) throw new HttpError(500, 'D1 binding “DB” is not configured for this environment.');
  if (!schemaPromise) {
    schemaPromise = createSchema(env.DB).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  try {
    await schemaPromise;
  } catch (error) {
    console.error(JSON.stringify({ event: 'schema_initialization_failed', message: error instanceof Error ? error.message : String(error) }));
    throw new HttpError(500, 'The lecture database could not be initialized. Check the DB binding and retry.');
  }
}

async function createSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS lectures (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      design_id TEXT NOT NULL CHECK (design_id IN ('classic', 'enhanced', 'editorial')),
      schema_version TEXT NOT NULL CHECK (schema_version IN ('1.0', '2.1')),
      r2_key TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      created_at TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS lectures_created_at_idx ON lectures(created_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS lectures_size_bytes_idx ON lectures(size_bytes)'),
    db.prepare('CREATE INDEX IF NOT EXISTS lectures_title_idx ON lectures(title COLLATE NOCASE)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS publish_rate_limits (
      ip TEXT PRIMARY KEY,
      window_started INTEGER NOT NULL,
      publish_count INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_login_attempts (
      ip TEXT PRIMARY KEY,
      window_started INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER NOT NULL DEFAULT 0
    )`)
  ]);
}

function requireLectureStorage(env) {
  if (!env.LECTURES) throw new HttpError(500, 'R2 binding “LECTURES” is not configured for this environment.');
}

async function publishLecture(request, env, url) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'The lecture body must be JSON.');
  if (!request.body) throw new HttpError(400, 'The lecture body is missing.');

  const designId = request.headers.get('X-Design-Id') || '';
  const schemaVersion = request.headers.get('X-Schema-Version') || '';
  const encodedTitle = request.headers.get('X-Lecture-Title') || '';
  const title = safeDecodeURIComponent(encodedTitle).trim().slice(0, 200);
  if (!DESIGNS.has(designId)) throw new HttpError(400, 'Unsupported lecture design.');
  if (!SCHEMA_VERSIONS.has(schemaVersion)) throw new HttpError(400, 'Unsupported schema version.');
  if (!title) throw new HttpError(400, 'Lecture title is required.');

  const maximumBytes = integerEnv(env.MAX_LECTURE_BYTES, DEFAULT_MAX_LECTURE_BYTES);
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > maximumBytes) throw new HttpError(413, `Lecture exceeds the ${formatMegabytes(maximumBytes)} MB limit.`);

  await checkPublishRate(env.DB, clientIp(request));

  const id = crypto.randomUUID();
  const r2Key = `lectures/${id}.json`;
  const createdAt = new Date().toISOString();
  const object = await env.LECTURES.put(r2Key, request.body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { designId, schemaVersion }
  });
  if (!object) throw new Error('R2 did not return the stored object.');

  if (object.size > maximumBytes) {
    await env.LECTURES.delete(r2Key);
    throw new HttpError(413, `Lecture exceeds the ${formatMegabytes(maximumBytes)} MB limit.`);
  }

  try {
    await env.DB.prepare(`
      INSERT INTO lectures (id, title, design_id, schema_version, r2_key, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, title, designId, schemaVersion, r2Key, object.size, createdAt).run();
  } catch (error) {
    await env.LECTURES.delete(r2Key);
    throw error;
  }

  console.log(JSON.stringify({ event: 'lecture_published', id, designId, schemaVersion, sizeBytes: object.size }));
  return json({ id, url: `${url.origin}/lecture/${id}`, title, designId, sizeBytes: object.size }, 201);
}

async function getLecture(id, env) {
  const record = await env.DB.prepare('SELECT design_id, r2_key FROM lectures WHERE id = ?').bind(id).first();
  if (!record) return json({ error: 'Lecture not found.' }, 404);

  const object = await env.LECTURES.get(record.r2_key);
  if (!object || !object.body) return json({ error: 'Lecture content is unavailable.' }, 404);

  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Design-Id': record.design_id
  });
  return new Response(object.body, { status: 200, headers });
}

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    throw new HttpError(500, 'Admin secrets are not configured for this environment.');
  }
  const ip = clientIp(request);
  await assertLoginAllowed(env.DB, ip);

  let input;
  try { input = await request.json(); } catch { throw new HttpError(400, 'Invalid login request.'); }
  const password = typeof input?.password === 'string' ? input.password : '';
  const valid = await secretEquals(password, env.ADMIN_PASSWORD);

  if (!valid) {
    await recordLoginFailure(env.DB, ip);
    throw new HttpError(401, 'Incorrect password.');
  }

  await env.DB.prepare('DELETE FROM admin_login_attempts WHERE ip = ?').bind(ip).run();
  const token = await createSessionToken(env.SESSION_SECRET);
  return json({ authenticated: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`
  });
}

function adminLogout() {
  return json({ authenticated: false }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
  });
}

async function adminStorage(env) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS lecture_count,
           COALESCE(SUM(size_bytes), 0) AS total_bytes,
           MIN(created_at) AS oldest_created_at
    FROM lectures
  `).first();
  const allowanceBytes = integerEnv(env.STORAGE_ALLOWANCE_BYTES, DEFAULT_ALLOWANCE_BYTES);
  const totalBytes = Number(row?.total_bytes || 0);
  return json({
    lectureCount: Number(row?.lecture_count || 0),
    totalBytes,
    allowanceBytes,
    usagePercent: allowanceBytes > 0 ? totalBytes / allowanceBytes * 100 : 0,
    oldestCreatedAt: row?.oldest_created_at || null
  });
}

async function adminLectures(env, url) {
  const page = clampInteger(url.searchParams.get('page'), 1, 1, 1_000_000);
  const pageSize = clampInteger(url.searchParams.get('pageSize'), 25, 1, 100);
  const search = (url.searchParams.get('search') || '').trim().slice(0, 100);
  const sort = url.searchParams.get('sort') || 'newest';
  const orderBy = {
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    largest: 'size_bytes DESC',
    smallest: 'size_bytes ASC',
    title: 'title COLLATE NOCASE ASC'
  }[sort] || 'created_at DESC';
  const offset = (page - 1) * pageSize;
  const pattern = `%${escapeLike(search)}%`;
  const where = search ? `WHERE title LIKE ? ESCAPE '\\'` : '';

  const countStatement = search
    ? env.DB.prepare(`SELECT COUNT(*) AS total FROM lectures ${where}`).bind(pattern)
    : env.DB.prepare('SELECT COUNT(*) AS total FROM lectures');
  const listStatement = search
    ? env.DB.prepare(`SELECT id, title, design_id, size_bytes, created_at FROM lectures ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(pattern, pageSize, offset)
    : env.DB.prepare(`SELECT id, title, design_id, size_bytes, created_at FROM lectures ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(pageSize, offset);

  const [countResult, listResult] = await env.DB.batch([countStatement, listStatement]);
  const total = Number(countResult.results?.[0]?.total || 0);
  const origin = url.origin;
  const items = (listResult.results || []).map((row) => ({
    id: row.id,
    title: row.title,
    designId: row.design_id,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    url: `${origin}/lecture/${row.id}`
  }));
  return json({ page, pageSize, total, items });
}

async function adminDeleteLecture(id, env) {
  const record = await env.DB.prepare('SELECT title, r2_key, size_bytes FROM lectures WHERE id = ?').bind(id).first();
  if (!record) return json({ error: 'Lecture not found.' }, 404);
  await env.LECTURES.delete(record.r2_key);
  await env.DB.prepare('DELETE FROM lectures WHERE id = ?').bind(id).run();
  console.log(JSON.stringify({ event: 'lecture_deleted', id, sizeBytes: Number(record.size_bytes) }));
  return json({ deleted: true, title: record.title, freedBytes: Number(record.size_bytes) });
}

async function adminCleanup(request, env) {
  let input;
  try { input = await request.json(); } catch { throw new HttpError(400, 'Invalid cleanup request.'); }
  const percentage = Number(input?.percentage);
  if (![10, 20, 50, 100].includes(percentage)) throw new HttpError(400, 'Cleanup percentage must be 10, 20, 50 or 100.');

  const summary = await env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM lectures').first();
  const totalBytes = Number(summary?.total_bytes || 0);
  if (totalBytes === 0) return json({ deletedLectures: 0, freedBytes: 0, remainingBytes: 0 });

  const targetBytes = percentage === 100 ? totalBytes : Math.ceil(totalBytes * percentage / 100);
  const result = await env.DB.prepare('SELECT id, r2_key, size_bytes FROM lectures ORDER BY created_at ASC, id ASC').all();
  const selected = [];
  let freedBytes = 0;
  for (const row of result.results || []) {
    selected.push(row);
    freedBytes += Number(row.size_bytes);
    if (freedBytes >= targetBytes) break;
  }

  for (const chunk of chunks(selected.map((row) => row.r2_key), 1000)) {
    await env.LECTURES.delete(chunk);
  }
  for (const chunk of chunks(selected.map((row) => row.id), 80)) {
    const placeholders = chunk.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM lectures WHERE id IN (${placeholders})`).bind(...chunk).run();
  }

  console.log(JSON.stringify({ event: 'storage_cleanup', percentage, deletedLectures: selected.length, freedBytes }));
  return json({ deletedLectures: selected.length, freedBytes, remainingBytes: Math.max(0, totalBytes - freedBytes) });
}

async function checkPublishRate(db, ip) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % 3600);
  const row = await db.prepare('SELECT window_started, publish_count FROM publish_rate_limits WHERE ip = ?').bind(ip).first();
  if (!row || Number(row.window_started) !== windowStart) {
    await db.prepare(`
      INSERT INTO publish_rate_limits (ip, window_started, publish_count)
      VALUES (?, ?, 1)
      ON CONFLICT(ip) DO UPDATE SET window_started = excluded.window_started, publish_count = 1
    `).bind(ip, windowStart).run();
    return;
  }
  if (Number(row.publish_count) >= PUBLISH_LIMIT_PER_HOUR) throw new HttpError(429, 'Publishing limit reached. Try again later.');
  await db.prepare('UPDATE publish_rate_limits SET publish_count = publish_count + 1 WHERE ip = ?').bind(ip).run();
}

async function assertLoginAllowed(db, ip) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT blocked_until FROM admin_login_attempts WHERE ip = ?').bind(ip).first();
  if (Number(row?.blocked_until || 0) > now) throw new HttpError(429, 'Too many failed attempts. Try again later.');
}

async function recordLoginFailure(db, ip) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT window_started, failures FROM admin_login_attempts WHERE ip = ?').bind(ip).first();
  const inWindow = row && now - Number(row.window_started) < LOGIN_WINDOW_SECONDS;
  const failures = inWindow ? Number(row.failures) + 1 : 1;
  const blockedUntil = failures >= LOGIN_FAILURE_LIMIT ? now + LOGIN_WINDOW_SECONDS : 0;
  await db.prepare(`
    INSERT INTO admin_login_attempts (ip, window_started, failures, blocked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET window_started = excluded.window_started, failures = excluded.failures, blocked_until = excluded.blocked_until
  `).bind(ip, inWindow ? Number(row.window_started) : now, failures, blockedUntil).run();
}

async function requireAdmin(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = parseCookies(request.headers.get('Cookie') || '')[SESSION_COOKIE];
  if (!token) return false;
  return verifySessionToken(token, env.SESSION_SECRET);
}

async function createSessionToken(secret) {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  const signature = await hmac(payload, secret);
  return `${payload}.${base64UrlEncode(signature)}`;
}

async function verifySessionToken(token, secret) {
  const [payload, signatureText, extra] = token.split('.');
  if (!payload || !signatureText || extra) return false;
  try {
    const expected = await hmac(payload, secret);
    const actual = base64UrlDecode(signatureText);
    if (expected.byteLength !== actual.byteLength || !crypto.subtle.timingSafeEqual(expected, actual)) return false;
    const data = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function secretEquals(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(left)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(right))
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function assertSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin mutation is not allowed.');
}

function serveAsset(env, request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  return env.ASSETS.fetch(new Request(url, request));
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

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function safeDecodeURIComponent(value) { try { return decodeURIComponent(value); } catch { return ''; } }
function clientIp(request) { return (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64); }
function integerEnv(value, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback; }
function clampInteger(value, fallback, minimum, maximum) { const number = Number.parseInt(value || '', 10); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
function escapeLike(value) { return value.replace(/[\\%_]/g, '\\$&'); }
function chunks(items, size) { const output = []; for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size)); return output; }
function formatMegabytes(bytes) { return Math.round(bytes / 1024 / 1024); }

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

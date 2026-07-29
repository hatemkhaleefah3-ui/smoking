import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function patchV4OpenverseResponse() {
  let source = await readFile(runtimePath, 'utf8');

  source = replaceRequired(
    source,
    `const MAX_PROVIDER_QUERY_ATTEMPTS = 3;`,
    `const MAX_PROVIDER_QUERY_ATTEMPTS = 3;
const OPENVERSE_RESPONSE_ATTEMPTS = 3;
const OPENVERSE_RETRY_BASE_MS = 250;`,
    'Openverse response retry constants'
  );

  source = replaceRequired(
    source,
    `        cycle
      });`,
    `        cycle,
        env
      });`,
    'provider environment context'
  );

  source = replaceRequired(
    source,
    `    ['Openverse', searchOpenverse],`,
    `    ['Openverse', (providerQuery, providerPage) => searchOpenverse(providerQuery, providerPage, context?.env)],`,
    'Openverse environment forwarding'
  );

  source = replaceRequired(
    source,
    `async function searchOpenverse(query, page) {
  const params = new URLSearchParams({
    q: query,
    license: OPENVERSE_LICENSES.join(','),
    excluded_source: 'wikimedia',
    page_size: String(RESULTS_PER_SOURCE),
    page: String(Math.max(1, page)),
    mature: 'false'
  });
  const response = await fetchWithTimeout(\`https://api.openverse.org/v1/images/?\${params}\`, {
    headers: apiHeaders('application/json')
  });
  if (!response.ok) throw new Error(\`Openverse returned \${response.status}.\`);
  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const candidates = [];

  for (const item of results) {
    const licenseCode = normalize(item?.license).replace(/ /g, '-');
    if (!OPENVERSE_LICENSES.includes(licenseCode)) continue;
    const previewUrl = cleanHttpsUrl(item?.thumbnail);
    const originalUrl = cleanHttpsUrl(item?.url);
    const displayUrl = previewUrl || originalUrl;
    if (!displayUrl) continue;
    const license = formatOpenverseLicense(item?.license, item?.license_version);
    candidates.push({
      url: displayUrl,
      reviewUrls: uniqueUrls([previewUrl, originalUrl]),
      originalUrl,
      source: 'Openverse',
      title: cleanText(item?.title, 240) || 'Untitled image',
      description: normalizeTags(item?.tags).slice(0, 360),
      creator: cleanText(item?.creator, 200),
      creatorUrl: cleanHttpsUrl(item?.creator_url),
      license,
      licenseUrl: cleanHttpsUrl(item?.license_url) || licenseUrlFor(license),
      attribution: cleanText(item?.attribution, 600) || buildAttribution(item?.title, item?.creator, license),
      sourcePage: cleanHttpsUrl(item?.foreign_landing_url || item?.detail_url),
      mimeType: normalizeMimeFromUrl(displayUrl)
    });
  }

  return { rawCount: results.length, candidates };
}`,
    `async function searchOpenverse(query, page, env = {}) {
  const params = new URLSearchParams({
    q: query,
    license: OPENVERSE_LICENSES.join(','),
    excluded_source: 'wikimedia',
    page_size: String(RESULTS_PER_SOURCE),
    page: String(Math.max(1, page)),
    mature: 'false',
    format: 'json'
  });
  const payload = await fetchOpenverseJson(\`https://api.openverse.org/v1/images/?\${params}\`, env);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const candidates = [];

  for (const item of results) {
    const licenseCode = normalize(item?.license).replace(/ /g, '-');
    if (!OPENVERSE_LICENSES.includes(licenseCode)) continue;
    const previewUrl = cleanHttpsUrl(item?.thumbnail);
    const originalUrl = cleanHttpsUrl(item?.url);
    const displayUrl = previewUrl || originalUrl;
    if (!displayUrl) continue;
    const license = formatOpenverseLicense(item?.license, item?.license_version);
    candidates.push({
      url: displayUrl,
      reviewUrls: uniqueUrls([previewUrl, originalUrl]),
      originalUrl,
      source: 'Openverse',
      title: cleanText(item?.title, 240) || 'Untitled image',
      description: normalizeTags(item?.tags).slice(0, 360),
      creator: cleanText(item?.creator, 200),
      creatorUrl: cleanHttpsUrl(item?.creator_url),
      license,
      licenseUrl: cleanHttpsUrl(item?.license_url) || licenseUrlFor(license),
      attribution: cleanText(item?.attribution, 600) || buildAttribution(item?.title, item?.creator, license),
      sourcePage: cleanHttpsUrl(item?.foreign_landing_url || item?.detail_url),
      mimeType: normalizeMimeFromUrl(displayUrl)
    });
  }

  return { rawCount: results.length, candidates };
}

async function fetchOpenverseJson(url, env) {
  const failures = [];
  for (let attempt = 1; attempt <= OPENVERSE_RESPONSE_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(url, {
        headers: openverseApiHeaders(env)
      });
    } catch (error) {
      failures.push(\`attempt \${attempt}: network \${cleanText(error instanceof Error ? error.message : String(error), 180)}\`);
      if (attempt < OPENVERSE_RESPONSE_ATTEMPTS) {
        await openverseRetryDelay(attempt);
        continue;
      }
      break;
    }

    const contentType = cleanText(response.headers.get('content-type'), 120).toLowerCase();
    const bodyText = await response.text();
    const bodyStart = bodyText.trimStart();
    const looksJson = /(?:^|[;+\\s])application\\/(?:[a-z0-9.+-]*\\+)?json(?:[;\\s]|$)/i.test(contentType)
      || bodyStart.startsWith('{')
      || bodyStart.startsWith('[');
    const retryableStatus = response.status === 429 || response.status >= 500;
    const htmlResponse = /^<!doctype\\s+html|^<html/i.test(bodyStart);

    if (response.ok && looksJson && !htmlResponse) {
      try {
        return JSON.parse(bodyText);
      } catch (error) {
        failures.push(\`attempt \${attempt}: invalid JSON \${cleanText(error instanceof Error ? error.message : String(error), 160)}\`);
      }
    } else {
      failures.push(openverseFailureSummary(response, contentType, bodyText, attempt));
    }

    if (attempt < OPENVERSE_RESPONSE_ATTEMPTS && (response.ok || retryableStatus || htmlResponse)) {
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      await openverseRetryDelay(attempt, retryAfter);
      continue;
    }
    break;
  }

  throw new Error(\`Openverse response failure after \${OPENVERSE_RESPONSE_ATTEMPTS} attempts: \${failures.join(' | ').slice(0, 900)}\`);
}

function openverseApiHeaders(env) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
  };
  const token = cleanText(env?.OPENVERSE_ACCESS_TOKEN, 4000);
  if (token) headers.Authorization = \`Bearer \${token}\`;
  return headers;
}

function openverseFailureSummary(response, contentType, bodyText, attempt) {
  const bodySnippet = cleanText(
    String(bodyText || '').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' '),
    220
  );
  const rate = [
    response.headers.get('x-ratelimit-available-anon-burst'),
    response.headers.get('x-ratelimit-available-anon-sustained')
  ].filter(Boolean).join('/');
  return [
    \`attempt \${attempt}\`,
    \`status \${response.status}\`,
    \`type \${contentType || 'missing'}\`,
    rate ? \`rate \${rate}\` : '',
    response.headers.get('retry-after') ? \`retry-after \${response.headers.get('retry-after')}\` : '',
    response.headers.get('cf-ray') ? \`cf-ray \${response.headers.get('cf-ray')}\` : '',
    bodySnippet ? \`body \${bodySnippet}\` : ''
  ].filter(Boolean).join(', ');
}

function parseRetryAfterMs(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, seconds * 1000);
  return 0;
}

async function openverseRetryDelay(attempt, retryAfterMs = 0) {
  const duration = Math.max(retryAfterMs, OPENVERSE_RETRY_BASE_MS * (2 ** (attempt - 1)));
  await new Promise((resolve) => setTimeout(resolve, Math.min(duration, 5000)));
}`,
    'Openverse JSON response handling'
  );

  await writeFile(runtimePath, source, 'utf8');
  return runtimePath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch V4 Openverse handling: ${label} source changed.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchV4OpenverseResponse();
  console.log('Patched V4 runtime with forced JSON Openverse requests, retries, and upstream diagnostics.');
}

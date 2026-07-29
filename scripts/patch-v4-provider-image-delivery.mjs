import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function patchV4ProviderImageDelivery() {
  let source = await readFile(runtimePath, 'utf8');

  source = replaceRequired(
    source,
    `const USER_AGENT = 'LecturePublisherMultiSourceSearch/4.2 (https://github.com/hatemkhaleefah3-ui/smoking)';`,
    `const USER_AGENT = 'LecturePublisherMediaSearchBot/4.5 (https://github.com/hatemkhaleefah3-ui/smoking; contact via repository issues)';`,
    'descriptive provider user-agent'
  );

  source = replaceRequired(
    source,
    `    return url.replace(/\/info\.json(?:\?.*)?$/i, '/full/!512,512/0/default.jpg');`,
    `    return url.replace(/\/info\.json(?:\?.*)?$/i, '/full/512,/0/default.jpg');`,
    'Wellcome IIIF width-preserving image URL'
  );

  source = replaceRequired(
    source,
    `      const response = await fetchWithTimeout(url, { headers: { Accept: 'image/*' } });`,
    `      const response = await fetchWithTimeout(url, { headers: imageRequestHeaders(candidate, url) });`,
    'provider image request headers'
  );

  source = replaceRequired(
    source,
    `async function createGroundedVisualBrief(context, env) {`,
    `function imageRequestHeaders(candidate, value) {
  const headers = {
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'User-Agent': USER_AGENT,
    'Api-User-Agent': USER_AGENT
  };
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname === 'upload.wikimedia.org' || hostname.endsWith('.wikimedia.org')) {
      headers.Referer = 'https://commons.wikimedia.org/';
    } else if (hostname === 'iiif.wellcomecollection.org' || hostname.endsWith('.wellcomecollection.org')) {
      headers.Referer = 'https://wellcomecollection.org/';
    } else if (candidate?.sourcePage) {
      const sourcePage = new URL(candidate.sourcePage);
      if (sourcePage.protocol === 'https:') headers.Referer = sourcePage.href;
    }
  } catch {
    // The candidate URL was validated before this point. Header fallback is sufficient.
  }
  return headers;
}

async function createGroundedVisualBrief(context, env) {`,
    'source-aware image request header helper'
  );

  await writeFile(runtimePath, source, 'utf8');
  return runtimePath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch V4 provider image delivery: ${label} source changed.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchV4ProviderImageDelivery();
  console.log('Patched V4 runtime with provider-safe image delivery headers and Wellcome IIIF URLs.');
}

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function patchV4ProviderImageHeaders() {
  let source = await readFile(runtimePath, 'utf8');

  source = replaceRequired(
    source,
    "      const response = await fetchWithTimeout(url, { headers: { Accept: 'image/*' } });",
    "      const response = await fetchWithTimeout(url, { headers: imageRequestHeaders(candidate, url) });",
    'identified provider image request headers'
  );

  source = replaceRequired(
    source,
    'async function createGroundedVisualBrief(context, env) {',
    `function imageRequestHeaders(candidate, value) {
  const headers = apiHeaders('image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8');
  let hostname = '';
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
  }

  if (candidate?.source === 'Wikimedia Commons' || hostname === 'upload.wikimedia.org') {
    headers.Referer = 'https://commons.wikimedia.org/';
  } else if (candidate?.source === 'Wellcome Collection' || hostname.endsWith('.wellcomecollection.org')) {
    headers.Referer = 'https://wellcomecollection.org/';
  }

  return headers;
}

async function createGroundedVisualBrief(context, env) {`,
    'provider image header helper'
  );

  await writeFile(runtimePath, source, 'utf8');
  return runtimePath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch V4 provider image headers: ${label} source changed.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchV4ProviderImageHeaders();
  console.log('Patched V4 runtime with identified provider image request headers.');
}

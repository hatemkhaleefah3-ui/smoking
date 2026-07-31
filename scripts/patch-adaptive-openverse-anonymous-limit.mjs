import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '..');

export async function patchAdaptiveOpenverseAnonymousLimit(root = defaultRoot) {
  const file = resolve(root, 'worker/src/image-search-provider-pool.js');
  const source = await readFile(file, 'utf8');

  let next = source;
  if (!next.includes('const OPENVERSE_RESULT_LIMIT = 20;')) {
    next = next.replace(
      'const PROVIDER_RESULT_LIMIT = 24;',
      'const PROVIDER_RESULT_LIMIT = 24;\nconst OPENVERSE_RESULT_LIMIT = 20;'
    );
  }

  next = next.replace(
    "endpoint.searchParams.set('page_size', String(PROVIDER_RESULT_LIMIT));",
    "endpoint.searchParams.set('page_size', String(OPENVERSE_RESULT_LIMIT));"
  );

  if (next === source) return false;
  if (!next.includes('const OPENVERSE_RESULT_LIMIT = 20;')
      || !next.includes("endpoint.searchParams.set('page_size', String(OPENVERSE_RESULT_LIMIT));")) {
    throw new Error('Could not apply the adaptive Openverse anonymous-limit patch.');
  }

  await writeFile(file, next, 'utf8');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = await patchAdaptiveOpenverseAnonymousLimit();
  console.log(changed
    ? 'Patched adaptive Openverse requests to the anonymous 20-result page limit.'
    : 'Adaptive Openverse anonymous page limit already patched.');
}

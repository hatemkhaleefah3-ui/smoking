import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const sourcePath = resolve(root, 'worker/src/media-search-multisource-v2.js');
const outputPath = resolve(root, 'worker/src/media-search-multisource-v3.generated.js');

export async function generateDiverseMediaEngine() {
  let source = await readFile(sourcePath, 'utf8');

  source = replaceRequired(source,
    "const USER_AGENT = 'LecturePublisherMultiSourceSearch/2.0 (https://github.com/hatemkhaleefah3-ui/smoking)';",
    "const USER_AGENT = 'LecturePublisherMultiSourceSearch/3.0 (https://github.com/hatemkhaleefah3-ui/smoking)';",
    'engine user agent');

  source = replaceRequired(source,
    'export async function handleMultiSourceMediaSearchV2(request, env) {',
    'export async function handleMultiSourceMediaSearchV3(request, env) {',
    'handler name');

  source = replaceRequired(source,
    "  const label = cleanText(input?.label, 240) || imageId || 'Lecture image';",
    `  const label = cleanText(input?.label, 240) || imageId || 'Lecture image';
  const searchRun = normalizeSearchRun(input?.searchRun);
  const excludedUrls = new Set(normalizeExcludedUrls(input?.excludedUrls));
  if (searchRun < 1 && excludedUrls.size === 0) return null;
  const resultPage = 1 + (searchRun % 5);`,
    'fresh-search input');

  source = replaceRequired(source,
    '    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label }, env);',
    '    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label, searchRun }, env);',
    'grounded search run');

  source = replaceRequired(source,
    '      const discovery = await discoverAllSources(query);',
    '      const discovery = await discoverAllSources(query, resultPage);',
    'provider result page');

  source = replaceRequired(source,
    '      const selected = chooseBalancedCandidates(discovery.candidates, successfullyReviewed, REVIEW_IMAGES_PER_CYCLE);',
    '      const selected = chooseBalancedCandidates(discovery.candidates, successfullyReviewed, REVIEW_IMAGES_PER_CYCLE, rotatedSourceOrder(cycle, searchRun), excludedUrls);',
    'rotating source balance');

  source = source.replaceAll(
    '          providerStatus: discovery.providers',
    '          providerStatus: discovery.providers,\n          resultPage');

  source = replaceRequired(source,
    "      engine: 'multi-source-v2',",
    `      engine: 'multi-source-v3',
      searchRun,
      resultPage,
      excludedPrevious: excludedUrls.size,`,
    'response engine metadata');

  source = replaceRequired(source,
    'async function discoverAllSources(query) {',
    'async function discoverAllSources(query, page) {',
    'provider discovery signature');
  source = replaceRequired(source,
    "    ['Wikimedia Commons', () => searchWikimedia(query)],\n    ['Openverse', () => searchOpenverse(query)],\n    ['Wellcome Collection', () => searchWellcome(query)]",
    "    ['Wikimedia Commons', () => searchWikimedia(query, page)],\n    ['Openverse', () => searchOpenverse(query, page)],\n    ['Wellcome Collection', () => searchWellcome(query, page)]",
    'paged provider calls');

  source = replaceRequired(source,
    'async function searchWikimedia(query) {',
    'async function searchWikimedia(query, page) {',
    'Wikimedia signature');
  source = replaceRequired(source,
    "    gsrlimit: String(RESULTS_PER_SOURCE),\n    gsrnamespace: '6',",
    "    gsrlimit: String(RESULTS_PER_SOURCE),\n    gsroffset: String((Math.max(1, page) - 1) * RESULTS_PER_SOURCE),\n    gsrnamespace: '6',",
    'Wikimedia offset');

  source = replaceRequired(source,
    'async function searchOpenverse(query) {',
    'async function searchOpenverse(query, page) {',
    'Openverse signature');
  source = replaceRequired(source,
    "    page_size: String(RESULTS_PER_SOURCE),\n    mature: 'false'",
    "    page_size: String(RESULTS_PER_SOURCE),\n    page: String(Math.max(1, page)),\n    mature: 'false'",
    'Openverse page');

  source = replaceRequired(source,
    'async function searchWellcome(query) {',
    'async function searchWellcome(query, page) {',
    'Wellcome signature');
  source = replaceRequired(source,
    "    pageSize: String(RESULTS_PER_SOURCE),\n    include: 'source.contributors,source.subjects,source.genres'",
    "    pageSize: String(RESULTS_PER_SOURCE),\n    page: String(Math.max(1, page)),\n    include: 'source.contributors,source.subjects,source.genres'",
    'Wellcome page');

  source = replaceRequired(source,
    'function chooseBalancedCandidates(candidates, reviewed, limit) {\n  const groups = new Map(SOURCE_ORDER.map((source) => [source, []]));',
    'function chooseBalancedCandidates(candidates, reviewed, limit, sourceOrder = SOURCE_ORDER, excludedUrls = new Set()) {\n  const groups = new Map(SOURCE_ORDER.map((source) => [source, []]));',
    'balanced candidate signature');
  source = replaceRequired(source,
    '    if (!key || reviewed.has(key)) continue;',
    '    if (!key || reviewed.has(key) || isExcludedCandidate(candidate, excludedUrls)) continue;',
    'candidate exclusion');
  source = replaceRequired(source,
    '    for (const source of SOURCE_ORDER) {\n      const group = groups.get(source) || [];',
    '    for (const source of sourceOrder) {\n      const group = groups.get(source) || [];',
    'rotated source iteration');

  source = replaceRequired(source,
    "    'Create one concise English keyword query suitable for Wikimedia Commons, Openverse, and Wellcome Collection.',",
    `    'Create one concise English keyword query suitable for Wikimedia Commons, Openverse, and Wellcome Collection.',
    context.searchRun > 0
      ? \`This is alternative search run \${context.searchRun}. Use different precise scientific synonyms and less-obvious collection terminology than earlier runs.\`
      : '',`,
    'grounded diversity instruction');

  source = replaceRequired(source,
    'async function loadReviewImages(candidates) {',
    `function rotatedSourceOrder(cycle, searchRun) {
  const shift = Math.abs((Number(cycle) - 1) + Number(searchRun || 0)) % SOURCE_ORDER.length;
  return [...SOURCE_ORDER.slice(shift), ...SOURCE_ORDER.slice(0, shift)];
}

function isExcludedCandidate(candidate, excludedUrls) {
  if (!(excludedUrls instanceof Set) || excludedUrls.size === 0) return false;
  return [candidate?.url, candidate?.originalUrl, candidate?.sourcePage]
    .map(cleanHttpsUrl)
    .filter(Boolean)
    .some((url) => excludedUrls.has(url));
}

function normalizeSearchRun(value) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(0, Math.min(999, number)) : 0;
}

function normalizeExcludedUrls(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanHttpsUrl).filter(Boolean))].slice(0, 120);
}

async function loadReviewImages(candidates) {`,
    'diversity helpers');

  await writeFile(outputPath, source, 'utf8');
  return outputPath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not generate diverse media engine: ${label} source changed.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateDiverseMediaEngine();
  console.log('Generated distinct-result multi-source engine.');
}

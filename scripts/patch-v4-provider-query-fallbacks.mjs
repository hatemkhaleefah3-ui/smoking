import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function patchV4ProviderQueryFallbacks() {
  let source = await readFile(runtimePath, 'utf8');

  source = replaceRequired(
    source,
    `const REQUEST_TIMEOUT_MS = 15_000;`,
    `const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_QUERY_ATTEMPTS = 3;
const PROVIDER_QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'to', 'with',
  'annotated', 'comparison', 'diagram', 'educational', 'figure', 'image', 'illustration', 'labeled', 'labelled', 'medical',
  'normal', 'pathway', 'photo', 'photograph', 'picture', 'process', 'showing', 'shows', 'through', 'visual'
]);`,
    'provider fallback constants'
  );

  source = replaceRequired(
    source,
    `      const discovery = await discoverAllSources(query, resultPage);`,
    `      const discovery = await discoverAllSources(query, resultPage, {
        label,
        keyConcepts: grounded.data.keyConcepts,
        altTexts,
        cycle
      });`,
    'provider fallback context'
  );

  source = replaceRequired(
    source,
    `async function discoverAllSources(query, page) {
  const jobs = [
    ['Wikimedia Commons', () => searchWikimedia(query, page)],
    ['Openverse', () => searchOpenverse(query, page)],
    ['Wellcome Collection', () => searchWellcome(query, page)]
  ];
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  const candidates = [];
  const providers = {};

  settled.forEach((result, index) => {
    const source = jobs[index][0];
    if (result.status === 'fulfilled') {
      candidates.push(...result.value.candidates);
      providers[source] = {
        ok: true,
        rawFound: result.value.rawCount,
        eligibleFound: result.value.candidates.length,
        error: ''
      };
    } else {
      providers[source] = {
        ok: false,
        rawFound: 0,
        eligibleFound: 0,
        error: cleanText(result.reason instanceof Error ? result.reason.message : String(result.reason), 300)
      };
    }
  });

  return { candidates, providers };
}`,
    `async function discoverAllSources(query, page, context = {}) {
  const queryPlan = buildProviderQueryPlan(query, context);
  const jobs = [
    ['Wikimedia Commons', searchWikimedia],
    ['Openverse', searchOpenverse],
    ['Wellcome Collection', searchWellcome]
  ];
  const settled = await Promise.allSettled(
    jobs.map(([, run]) => searchProviderWithFallback(run, queryPlan, page))
  );
  const candidates = [];
  const providers = {};

  settled.forEach((result, index) => {
    const source = jobs[index][0];
    if (result.status === 'fulfilled') {
      candidates.push(...result.value.candidates);
      providers[source] = {
        ok: true,
        rawFound: result.value.rawCount,
        eligibleFound: result.value.candidates.length,
        queryAttempts: result.value.queryAttempts,
        queriesTried: result.value.queriesTried,
        matchedQuery: result.value.matchedQuery,
        error: ''
      };
    } else {
      providers[source] = {
        ok: false,
        rawFound: 0,
        eligibleFound: 0,
        queryAttempts: 0,
        queriesTried: queryPlan.slice(0, MAX_PROVIDER_QUERY_ATTEMPTS),
        matchedQuery: '',
        error: cleanText(result.reason instanceof Error ? result.reason.message : String(result.reason), 300)
      };
    }
  });

  return { candidates, providers, queryPlan };
}

async function searchProviderWithFallback(run, queryPlan, page) {
  const queriesTried = [];
  let lastResult = { rawCount: 0, candidates: [] };

  for (const providerQuery of queryPlan.slice(0, MAX_PROVIDER_QUERY_ATTEMPTS)) {
    queriesTried.push(providerQuery);
    const result = await run(providerQuery, page);
    lastResult = result;
    if (result.rawCount > 0 || result.candidates.length > 0) {
      return {
        ...result,
        queryAttempts: queriesTried.length,
        queriesTried,
        matchedQuery: providerQuery
      };
    }
  }

  return {
    ...lastResult,
    queryAttempts: queriesTried.length,
    queriesTried,
    matchedQuery: ''
  };
}

function buildProviderQueryPlan(query, context) {
  const output = [];
  const seen = new Set();
  const add = (value) => {
    const cleaned = cleanQuery(value);
    const key = normalize(cleaned);
    if (!cleaned || !key || seen.has(key)) return;
    seen.add(key);
    output.push(cleaned);
  };

  add(query);
  const labelTokens = providerQueryTokens(context?.label);
  add(labelTokens.slice(0, 4).join(' '));

  const conceptTokens = [
    ...labelTokens,
    ...normalizeTexts(context?.keyConcepts, 12, 180).flatMap(providerQueryTokens),
    ...providerQueryTokens(query),
    ...normalizeTexts(context?.altTexts, 8, 1200).flatMap(providerQueryTokens)
  ];
  const rotated = rotateUniqueTokens(conceptTokens, Number(context?.cycle || 1) - 1);
  for (const token of rotated) add(token);

  return output.slice(0, 8);
}

function providerQueryTokens(value) {
  return (normalize(value).match(/[\\p{L}\\p{N}]+/gu) || [])
    .filter((token) => token.length >= 3 && token.length <= 40 && !PROVIDER_QUERY_STOP_WORDS.has(token));
}

function rotateUniqueTokens(values, shift) {
  const unique = [...new Set(values.filter(Boolean))];
  if (!unique.length) return [];
  const offset = Math.abs(Number(shift) || 0) % unique.length;
  return [...unique.slice(offset), ...unique.slice(0, offset)];
}`,
    'provider query fallback engine'
  );

  source = replaceRequired(
    source,
    `    include: 'source.contributors,source.subjects,source.genres,source.locations'`,
    `    include: 'source.contributors,source.subjects,source.genres'`,
    'supported Wellcome include fields'
  );

  source = replaceRequired(
    source,
    `    searchCalls: 0,
    rawFound: 0,`,
    `    searchCalls: 0,
    queryAttempts: 0,
    lastQueries: [],
    matchedQuery: '',
    rawFound: 0,`,
    'provider diagnostic query fields'
  );

  source = replaceRequired(
    source,
    `    target[source].searchCalls += 1;
    target[source].rawFound += Number(status.rawFound) || 0;`,
    `    target[source].searchCalls += 1;
    target[source].queryAttempts += Number(status.queryAttempts) || 0;
    target[source].lastQueries = Array.isArray(status.queriesTried) ? status.queriesTried.slice(0, MAX_PROVIDER_QUERY_ATTEMPTS) : [];
    target[source].matchedQuery = cleanQuery(status.matchedQuery);
    target[source].rawFound += Number(status.rawFound) || 0;`,
    'provider diagnostic query aggregation'
  );

  await writeFile(runtimePath, source, 'utf8');
  return runtimePath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch V4 provider queries: ${label} source changed.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchV4ProviderQueryFallbacks();
  console.log('Patched V4 runtime with provider query fallbacks and current Wellcome parameters.');
}

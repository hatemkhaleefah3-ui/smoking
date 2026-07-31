import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { patchAdaptiveImageSearchDiagnostics } from './patch-adaptive-image-search-diagnostics.mjs';

await patchAdaptiveImageSearchDiagnostics();
await patchAdaptiveImageSearchDiagnostics();

const provider = await readFile(new URL('../worker/src/image-search-provider-pool.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../worker/src/image-search-data-driven.js', import.meta.url), 'utf8');
const frontendSource = await readFile(new URL('../adaptive-image-search.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../adaptive-image-search-data-driven.css', import.meta.url), 'utf8');
const workerBundle = await readFile(new URL('../dist/_worker.js', import.meta.url), 'utf8');
const frontendBundle = await readFile(new URL('../dist/adaptive-image-search.js', import.meta.url), 'utf8');

assert.match(provider, /Promise\.allSettled/);
assert.match(provider, /requestUrl/);
assert.match(provider, /fetchThrew/);
assert.match(provider, /fetchErrorName/);
assert.match(provider, /fetchErrorMessage/);
assert.match(provider, /failureType/);
assert.match(provider, /responseStatus/);
assert.match(provider, /responseOk/);
assert.match(provider, /rawBodyPreview/);
assert.match(provider, /parsedResultCount/);
assert.match(provider, /afterProviderFilterCount/);
assert.match(provider, /beforeCrossProviderDedup/);
assert.match(provider, /afterCrossProviderDedup/);
assert.match(provider, /no response \(network\/CORS error\)/);
assert.match(provider, /server returned/);

assert.match(workerSource, /DIAGNOSTIC_PIPELINE_VERSION/);
assert.match(workerSource, /rawByProvider/);
assert.match(workerSource, /afterProviderFilteringByProvider/);
assert.match(workerSource, /afterKeywordFiltering/);
assert.match(workerSource, /afterFeedbackRankingOrDemotion/);
assert.match(workerSource, /finalCountPassedToRender/);
assert.match(workerSource, /finalDomRenderedCount/);
assert.match(workerSource, /adaptive_image_pipeline_counts/);

assert.match(frontendSource, /adaptive-image-debug-panel/);
assert.match(frontendSource, /Provider request \/ response diagnostics/);
assert.match(frontendSource, /Raw parsed result count/);
assert.match(frontendSource, /scheduleRenderedCountMeasurement/);
assert.match(frontendSource, /querySelectorAll\('\.adaptive-image-card'\)\.length/);
assert.match(frontendSource, /Actually rendered in DOM/);
assert.match(frontendSource, /Render count match/);
assert.match(frontendSource, /no response \(network\/CORS error\)/);
assert.match(frontendSource, /server returned/);
assert.match(cssSource, /\.adaptive-image-debug-panel/);
assert.match(cssSource, /\.adaptive-debug-grid/);
assert.match(cssSource, /has-count-mismatch/);

assert.match(workerBundle, /adaptive_image_provider_diagnostics/);
assert.match(workerBundle, /adaptive_image_pipeline_counts/);
assert.match(workerBundle, /rawBodyPreview/);
assert.match(workerBundle, /parsedResultCount/);
assert.match(workerBundle, /afterCrossProviderDedup/);
assert.match(frontendBundle, /adaptive-image-debug-panel/);
assert.match(frontendBundle, /finalDomRenderedCount/);
assert.match(frontendBundle, /render count diagnostic/);

console.log('Adaptive image-search provider, pipeline, and DOM diagnostics validation passed.');

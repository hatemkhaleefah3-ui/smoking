import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateV4RuntimeEngine } from './generate-v4-runtime-engine.mjs';
import { patchV4ProviderQueryFallbacks } from './patch-v4-provider-query-fallbacks.mjs';
import { patchV4OpenverseResponse } from './patch-v4-openverse-response.mjs';
import { patchV4ProviderImageDelivery } from './patch-v4-provider-image-delivery.mjs';
import { patchV4ProviderFunnelDiagnostics } from './patch-v4-provider-funnel-diagnostics.mjs';

const outputPath = await generateV4RuntimeEngine();
await patchV4ProviderQueryFallbacks();
await patchV4OpenverseResponse();
await patchV4ProviderImageDelivery();
await patchV4ProviderFunnelDiagnostics();
const source = await readFile(outputPath, 'utf8');

assert.match(source, /handleMultiSourceMediaSearchV4Runtime/);
assert.match(source, /engine: 'multi-source-v4-runtime'/);
assert.match(source, /const generationConfig = googleSearch\s*\? \{ maxOutputTokens \}/);
assert.match(source, /Required JSON schema:/);
assert.match(source, /Do not include Markdown fences or explanatory text/);
assert.match(source, /responseFormat: \{ text: \{ mimeType: 'application\/json', schema \} \}/);
assert.match(source, /gemini-3\.5-flash-lite/);
assert.match(source, /gemini-3\.1-flash-lite/);
assert.match(source, /response\.status === 429 \|\| response\.status >= 500/);
assert.match(source, /await delay\(250 \* \(2 \*\* index\)\)/);
assert.match(source, /Gemini models unavailable/);
assert.match(source, /geminiModelsUsed: \[\.\.\.geminiModelsUsed\]/);

assert.match(source, /const MAX_PROVIDER_QUERY_ATTEMPTS = 3/);
assert.match(source, /buildProviderQueryPlan\(query, context\)/);
assert.match(source, /searchProviderWithFallback\(run, queryPlan, page\)/);
assert.match(source, /labelTokens\.slice\(0, 4\)\.join\(' '\)/);
assert.match(source, /for \(const token of rotated\) add\(token\)/);
assert.match(source, /queryAttempts: result\.value\.queryAttempts/);
assert.match(source, /queriesTried: result\.value\.queriesTried/);
assert.match(source, /matchedQuery: result\.value\.matchedQuery/);
assert.match(source, /include: 'source\.contributors,source\.subjects,source\.genres'/);
assert.doesNotMatch(source, /include: 'source\.contributors,source\.subjects,source\.genres,source\.locations'/);
assert.match(source, /target\[source\]\.queryAttempts \+= Number\(status\.queryAttempts\) \|\| 0/);

assert.match(source, /const OPENVERSE_RESPONSE_ATTEMPTS = 3/);
assert.match(source, /async function searchOpenverse\(query, page, env = \{\}\)/);
assert.match(source, /format: 'json'/);
assert.match(source, /const payload = await fetchOpenverseJson/);
assert.match(source, /async function fetchOpenverseJson/);
assert.match(source, /content-type/);
assert.match(source, /htmlResponse/);
assert.match(source, /Openverse response failure after/);
assert.match(source, /OPENVERSE_ACCESS_TOKEN/);
assert.match(source, /x-ratelimit-available-anon-burst/);
assert.match(source, /cf-ray/);

assert.match(source, /LecturePublisherMediaSearchBot\/4\.5/);
assert.match(source, /headers: imageRequestHeaders\(candidate, url\)/);
assert.match(source, /'User-Agent': USER_AGENT/);
assert.match(source, /'Api-User-Agent': USER_AGENT/);
assert.match(source, /headers\.Referer = 'https:\/\/commons\.wikimedia\.org\/'/);
assert.match(source, /headers\.Referer = 'https:\/\/wellcomecollection\.org\/'/);
assert.match(source, /\/full\/512,\/0\/default\.jpg/);
assert.doesNotMatch(source, /\/full\/!512,512\/0\/default\.jpg/);

assert.match(source, /groundingFailure/);
assert.match(source, /groundingUnavailable/);
assert.match(source, /providerFallbackRelevance/);
assert.match(source, /fallbackMode: fallbackAvailable \? 'provider-text-ranking' : ''/);
assert.match(source, /gemini-unavailable-provider-fallback/);
assert.match(source, /status: fallbackAvailable \? 200/);
assert.match(source, /images: imageResults\.map/);
assert.match(source, /usefulCount: imageResults\.length/);
assert.match(source, /discoveryCompleted: true/);
assert.match(source, /discoveredSourceCounts: countSources\(discovery\.candidates\)/);
assert.match(source, /loadedSourceCounts: countSources\(loadedResult\.loaded\)/);
assert.match(source, /providerDiagnostics,/);
assert.doesNotMatch(source, /if \(input\?\.diagnosticMode !== true\) throw error/);
assert.match(source, /responseText\.slice\(start, end \+ 1\)/);

const syntax = spawnSync(process.execPath, ['--check', resolve(outputPath)], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

const originalFetch = globalThis.fetch;
try {
  let geminiCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exhausted in fallback test.' } }, { status: 429 });
    }
    if (value.startsWith('https://commons.wikimedia.org/w/api.php?')) {
      return Response.json({
        query: {
          pages: {
            1: {
              pageid: 1,
              title: 'File:Glycine cleavage system diagram.png',
              imageinfo: [{
                mime: 'image/png',
                url: 'https://upload.wikimedia.test/glycine.png',
                thumburl: 'https://upload.wikimedia.test/glycine-thumb.png',
                extmetadata: {
                  ImageDescription: { value: 'Glycine synthesis and oxidation pathway diagram.' },
                  Artist: { value: 'Wikimedia contributor' },
                  LicenseShortName: { value: 'CC BY-SA 4.0' },
                  LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
                }
              }]
            }
          }
        }
      });
    }
    if (value.startsWith('https://api.openverse.org/v1/images/?')) {
      return Response.json({
        results: [{
          id: 'glycine-openverse',
          title: 'Glycine metabolism pathway',
          thumbnail: 'https://images.openverse.test/glycine-thumb.jpg',
          url: 'https://images.openverse.test/glycine.jpg',
          creator: 'Openverse contributor',
          license: 'by',
          license_version: '4.0',
          license_url: 'https://creativecommons.org/licenses/by/4.0/',
          foreign_landing_url: 'https://example.org/openverse/glycine',
          tags: [{ name: 'glycine' }, { name: 'metabolism' }, { name: 'oxidation' }]
        }]
      });
    }
    if (value.startsWith('https://api.wellcomecollection.org/catalogue/v2/images?')) {
      return Response.json({
        results: [{
          id: 'glycine-wellcome',
          source: {
            id: 'glycine-work',
            title: 'Glycine metabolic reactions',
            description: 'Biochemical synthesis and oxidation reactions.',
            contributors: [{ agent: { label: 'Wellcome contributor' } }],
            subjects: [{ label: 'Glycine metabolism' }],
            genres: [{ label: 'Medical illustration' }],
            license: {
              id: 'cc-by-4.0',
              label: 'CC BY 4.0',
              url: 'https://creativecommons.org/licenses/by/4.0/'
            },
            locations: [{
              url: 'https://iiif.wellcome.test/glycine/info.json',
              credit: 'Wellcome Collection — CC BY 4.0'
            }]
          }
        }]
      });
    }
    if (value.startsWith('https://upload.wikimedia.test/')
      || value.startsWith('https://images.openverse.test/')
      || value.startsWith('https://iiif.wellcome.test/')) {
      return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
        headers: { 'content-type': 'image/png', 'content-length': '8' }
      });
    }
    throw new Error(`Unexpected fallback-test URL: ${value}`);
  };

  const runtimeModule = await import(`${pathToFileURL(outputPath).href}?fallback-test=${Date.now()}`);
  const response = await runtimeModule.handleMultiSourceMediaSearchV4Runtime(new Request('https://example.com/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({
      intentSearch: true,
      strictRelevance: true,
      imageId: 'img-glycine-synthesis-oxidation',
      label: 'Glycine synthesis and oxidation reactions',
      altTexts: [
        'Biochemical pathway diagram showing glycine synthesis from serine and oxidation through the glycine cleavage system.'
      ],
      searchRun: 0,
      excludedUrls: []
    })
  }), { GEMINI_API_KEY: 'quota-exhausted-test-key' });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.engine, 'multi-source-v4-runtime');
  assert.equal(payload.visualReview, false);
  assert.equal(payload.fallbackMode, 'provider-text-ranking');
  assert.equal(payload.quotaExhausted, true);
  assert.equal(payload.diagnosticFailure, false);
  assert.equal(payload.usefulCount, 3);
  assert.equal(payload.imageResults.length, 3);
  assert.deepEqual(new Set(payload.imageResults.map((item) => item.source)), new Set([
    'Wikimedia Commons',
    'Openverse',
    'Wellcome Collection'
  ]));
  assert.ok(payload.imageResults.every((item) => item.url.startsWith('https://')));
  assert.equal(payload.stoppedReason, 'gemini-unavailable-provider-fallback');
  assert.equal(geminiCalls, 3, 'All configured Gemini models should be tried before provider fallback.');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('V4.7 provider-query, image-delivery, and Gemini-quota provider fallback validation passed.');

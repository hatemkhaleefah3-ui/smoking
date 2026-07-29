import assert from 'node:assert/strict';
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

const runtime = await import(`../worker/src/media-search-multisource-v4-runtime.generated.js?openverse-test=${Date.now()}`);
const originalFetch = globalThis.fetch;
let geminiCalls = 0;
let openverseSearchCalls = 0;
let openverseImageLoads = 0;
let wikimediaImageLoads = 0;
let wellcomeImageLoads = 0;

try {
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
    }

    if (value.startsWith('https://commons.wikimedia.org/w/api.php?')) {
      return Response.json({
        query: {
          pages: {
            1: {
              pageid: 1,
              title: 'File:Albinism diagram.png',
              imageinfo: [{
                mime: 'image/png',
                url: 'https://upload.wikimedia.org/albinism.png',
                thumburl: 'https://upload.wikimedia.org/albinism-thumb.png',
                extmetadata: {
                  ImageDescription: { value: 'Albinism medical diagram' },
                  Artist: { value: 'Wikimedia author' },
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
      openverseSearchCalls += 1;
      const requestUrl = new URL(value);
      assert.equal(requestUrl.searchParams.get('format'), 'json');
      assert.equal(options.headers.Accept, 'application/json');
      if (openverseSearchCalls === 1) {
        return new Response('\n<!DOCTYPE html><html><body>Temporary upstream HTML page</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cf-ray': 'test-ray' }
        });
      }
      return Response.json({
        results: [{
          id: 'openverse-albinism',
          title: 'Albinism educational image',
          thumbnail: 'https://api.openverse.org/v1/images/openverse-albinism/thumb/',
          url: 'https://images.openverse.test/openverse-albinism.jpg',
          creator: 'Openverse author',
          license: 'by-nc',
          license_version: '4.0',
          license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
          attribution: 'Albinism educational image — Openverse author — CC BY-NC 4.0',
          foreign_landing_url: 'https://example.org/openverse-albinism',
          tags: [{ name: 'albinism' }, { name: 'melanin' }]
        }]
      }, {
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-available-anon-burst': '18',
          'x-ratelimit-available-anon-sustained': '198'
        }
      });
    }

    if (value.startsWith('https://api.wellcomecollection.org/catalogue/v2/images?')) {
      const requestUrl = new URL(value);
      assert.equal(requestUrl.searchParams.get('include'), 'source.contributors,source.subjects,source.genres');
      return Response.json({
        results: [{
          id: 'wellcome-albinism',
          thumbnail: {
            url: 'https://iiif.wellcomecollection.org/image/wellcome-albinism/info.json',
            credit: 'Wellcome Collection',
            license: {
              id: 'cc-by',
              label: 'CC BY 4.0',
              url: 'https://creativecommons.org/licenses/by/4.0/'
            }
          },
          source: {
            id: 'wellcome-work',
            title: 'Albinism medical illustration',
            contributors: [{ agent: { label: 'Wellcome author' } }],
            subjects: [{ label: 'Albinism' }],
            genres: [{ label: 'Medical illustration' }]
          }
        }]
      });
    }

    if (value.startsWith('https://upload.wikimedia.org/')) {
      wikimediaImageLoads += 1;
      assert.match(options.headers['User-Agent'], /LecturePublisherMediaSearchBot\/4\.5/);
      assert.equal(options.headers.Referer, 'https://commons.wikimedia.org/');
      return imageResponse('image/png');
    }

    if (value === 'https://api.openverse.org/v1/images/openverse-albinism/thumb/') {
      openverseImageLoads += 1;
      return imageResponse('image/jpeg');
    }

    if (value.includes('iiif.wellcomecollection.org/image/wellcome-albinism/full/512,/0/default.jpg')) {
      wellcomeImageLoads += 1;
      assert.equal(options.headers.Referer, 'https://wellcomecollection.org/');
      return imageResponse('image/jpeg');
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  const response = await runtime.handleMultiSourceMediaSearchV4Runtime(new Request('https://example.com/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({
      intentSearch: true,
      strictRelevance: true,
      diagnosticMode: true,
      imageId: 'img-albinism',
      label: 'Albinism melanin synthesis pathway',
      altTexts: ['Medical diagram showing tyrosinase, DOPA, melanin, and albinism.'],
      searchRun: 0,
      excludedUrls: []
    })
  }), { GEMINI_API_KEY: 'quota-exhausted-test-key' });

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.engine, 'multi-source-v4-runtime');
  assert.equal(payload.discoveryCompleted, true);
  assert.equal(payload.visualReview, false);
  assert.equal(payload.stoppedReason, 'gemini-unavailable-before-visual-review');
  assert.equal(geminiCalls, 3);
  assert.equal(openverseSearchCalls, 2, 'Openverse HTML must be retried once before the JSON response succeeds.');
  assert.equal(openverseImageLoads, 1);
  assert.ok(wikimediaImageLoads >= 1);
  assert.equal(wellcomeImageLoads, 1);
  assert.equal(payload.providerDiagnostics.Openverse.rawFound, 1);
  assert.equal(payload.providerDiagnostics.Openverse.eligibleFound, 1);
  assert.equal(payload.providerDiagnostics.Openverse.loaded, 1);
  assert.equal(payload.providerDiagnostics.Openverse.searchErrors, 0);
  assert.equal(payload.providerDiagnostics.Openverse.imageErrors, 0);
  assert.equal(payload.loadedSourceCounts.Openverse, 1);

  console.log('V4.6 Openverse HTML recovery and thumbnail loading validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function imageResponse(contentType) {
  return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
    headers: { 'content-type': contentType, 'content-length': '8' }
  });
}

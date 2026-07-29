import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  let groundingCalls = 0;
  let reviewCalls = 0;
  let wikimediaSearches = 0;
  let openverseSearches = 0;
  let wellcomeSearches = 0;
  let wellcomeInfoJsonFetches = 0;
  let wellcomeImageFetches = 0;
  let openverseThumbFailures = 0;
  let openverseOriginalFetches = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(options.body);
      if (Array.isArray(body.tools)) {
        groundingCalls += 1;
        assert.deepEqual(body.tools, [{ google_search: {} }]);
        return geminiResponse({
          visualBrief: 'A medical biochemical pathway diagram showing tyrosinase, DOPA, melanin, and albinism.',
          keyConcepts: ['tyrosinase', 'DOPA', 'melanin', 'albinism'],
          expectedVisualFeatures: ['reaction arrows', 'blocked tyrosinase step', 'melanin product'],
          firstSearchQuery: 'tyrosinase melanin albinism pathway diagram'
        }, {
          webSearchQueries: ['tyrosinase melanin pathway diagram'],
          groundingChunks: [{ web: { title: 'Medical reference', uri: 'https://example.org/reference' } }]
        });
      }

      reviewCalls += 1;
      const inlineImages = body.contents[0].parts.filter((part) => part.inlineData);
      assert.equal(inlineImages.length, 4, 'Each cycle must inspect four source-balanced thumbnails.');
      return geminiResponse({
        decisions: [0, 1, 2, 3].map((index) => ({
          index,
          resembles: true,
          resemblanceScore: 96 - index,
          reason: 'The visible medical pathway matches the intended image.'
        })),
        nextQuery: `refined medical pathway query ${reviewCalls + 1}`
      });
    }

    if (value.startsWith('https://commons.wikimedia.org/w/api.php?')) {
      wikimediaSearches += 1;
      return wikimediaResponse(wikimediaSearches);
    }

    if (value.startsWith('https://api.openverse.org/v1/images/?')) {
      openverseSearches += 1;
      const requestUrl = new URL(value);
      assert.match(requestUrl.searchParams.get('license') || '', /by-nc/);
      return openverseResponse(openverseSearches);
    }

    if (value.startsWith('https://api.wellcomecollection.org/catalogue/v2/images?')) {
      wellcomeSearches += 1;
      return wellcomeResponse(wellcomeSearches);
    }

    if (/\/info\.json(?:\?|$)/.test(value)) {
      wellcomeInfoJsonFetches += 1;
      return Response.json({ error: 'The engine must convert info.json to an IIIF image request.' });
    }

    if (value.includes('/full/!512,512/0/default.jpg')) {
      wellcomeImageFetches += 1;
      return imageResponse('image/jpeg');
    }

    if (value.startsWith('https://api.openverse.org/v1/images/') && value.endsWith('/thumb/')) {
      openverseThumbFailures += 1;
      return new Response('thumbnail proxy unavailable', { status: 503 });
    }

    if (value.startsWith('https://images.openverse.test/')) {
      openverseOriginalFetches += 1;
      return imageResponse('image/png');
    }

    if (value.startsWith('https://upload.wikimedia.org/')) {
      return imageResponse('image/png');
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  const response = await worker.fetch(new Request('https://example.com/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({
      intentSearch: true,
      strictRelevance: true,
      imageId: 'img-albinism-pathway',
      label: 'Albinism pathway',
      altTexts: [
        'Diagram showing tyrosinase-dependent conversion of tyrosine through DOPA to melanin.',
        'Pathway illustrating impaired melanin synthesis in albinism.'
      ]
    })
  }), { GEMINI_API_KEY: 'test-key' });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.engine, 'multi-source-v2');
  assert.equal(payload.multiSource, true);
  assert.equal(payload.searchRounds, 4, 'Five accepted images should be followed by exactly two additional cycles.');
  assert.equal(payload.stoppedReason, 'minimum-plus-two-cycles');
  assert.equal(payload.usefulCount, 16);
  assert.equal(groundingCalls, 1);
  assert.equal(reviewCalls, 4);
  assert.equal(wikimediaSearches, 4);
  assert.equal(openverseSearches, 4);
  assert.equal(wellcomeSearches, 4);
  assert.equal(wellcomeInfoJsonFetches, 0, 'Wellcome info.json must never be sent to the image loader.');
  assert.ok(wellcomeImageFetches >= 4, 'Converted Wellcome IIIF images should be loaded.');
  assert.ok(openverseThumbFailures >= 4, 'The test should exercise Openverse thumbnail failure.');
  assert.ok(openverseOriginalFetches >= 4, 'Openverse original URLs should be retried after thumbnail failure.');
  assert.equal(payload.sourceCounts['Wikimedia Commons'], 8);
  assert.equal(payload.sourceCounts.Openverse, 4);
  assert.equal(payload.sourceCounts['Wellcome Collection'], 4);
  assert.ok(payload.providerDiagnostics.Openverse.loaded >= 4);
  assert.ok(payload.providerDiagnostics['Wellcome Collection'].loaded >= 4);
  assert.ok(payload.imageResults.some((item) => item.source === 'Openverse' && /CC BY-NC/.test(item.license)));
  assert.ok(payload.imageResults.some((item) => item.source === 'Wellcome Collection' && item.sourcePage));
  assert.ok(payload.imageResults.every((item) => item.attribution && item.license));

  console.log('Corrected multi-source provider delivery validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function geminiResponse(value, groundingMetadata) {
  return Response.json({
    candidates: [{
      content: { parts: [{ text: JSON.stringify(value) }] },
      ...(groundingMetadata ? { groundingMetadata } : {})
    }]
  });
}

function wikimediaResponse(cycle) {
  const pages = {};
  for (let index = 0; index < 2; index += 1) {
    const id = `wikimedia-${cycle}-${index + 1}`;
    pages[index + 1] = {
      pageid: cycle * 10 + index,
      title: `File:${id}.png`,
      imageinfo: [{
        mime: 'image/png',
        url: `https://upload.wikimedia.org/${id}.png`,
        thumburl: `https://upload.wikimedia.org/thumb/${id}.png`,
        extmetadata: {
          ImageDescription: { value: '<p>Medical pathway diagram</p>' },
          Artist: { value: 'Wikimedia contributor' },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
        }
      }]
    };
  }
  return Response.json({ query: { pages } });
}

function openverseResponse(cycle) {
  return Response.json({
    results: [
      {
        id: `openverse-${cycle}`,
        title: `Openverse medical pathway ${cycle}`,
        thumbnail: `https://api.openverse.org/v1/images/openverse-${cycle}/thumb/`,
        url: `https://images.openverse.test/openverse-${cycle}.png`,
        creator: 'Openverse creator',
        creator_url: 'https://example.org/creator',
        license: 'by-nc',
        license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        attribution: `Openverse pathway ${cycle} — Openverse creator — CC BY-NC 4.0`,
        foreign_landing_url: `https://example.org/openverse/${cycle}`,
        tags: [{ name: 'melanin' }, { name: 'tyrosinase' }]
      },
      {
        id: `excluded-openverse-${cycle}`,
        title: 'No derivatives image',
        thumbnail: `https://api.openverse.org/v1/images/excluded-${cycle}/thumb/`,
        url: `https://images.openverse.test/excluded-${cycle}.png`,
        creator: 'Excluded creator',
        license: 'by-nd',
        license_version: '4.0'
      }
    ]
  });
}

function wellcomeResponse(cycle) {
  return Response.json({
    results: [
      {
        id: `wellcome-image-${cycle}`,
        thumbnail: {
          url: `https://iiif.wellcomecollection.org/image-${cycle}/info.json`,
          credit: `Wellcome pathway ${cycle} — Wellcome Collection — CC BY-NC 4.0`,
          license: {
            id: 'cc-by-nc-4.0',
            label: 'CC BY-NC 4.0',
            url: 'https://creativecommons.org/licenses/by-nc/4.0/'
          }
        },
        source: {
          id: `work-${cycle}`,
          title: `Wellcome medical pathway ${cycle}`,
          description: 'Historical medical pathway illustration',
          contributors: [{ agent: { label: 'Wellcome artist' } }],
          subjects: [{ label: 'Melanin' }],
          genres: [{ label: 'Medical illustration' }]
        }
      },
      {
        id: `restricted-wellcome-${cycle}`,
        thumbnail: {
          url: `https://iiif.wellcomecollection.org/restricted-${cycle}/info.json`,
          license: { id: 'inc', label: 'In copyright' }
        },
        source: { id: `restricted-work-${cycle}`, title: 'Restricted image' }
      }
    ]
  });
}

function imageResponse(contentType) {
  return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
    headers: { 'content-type': contentType, 'content-length': '8' }
  });
}

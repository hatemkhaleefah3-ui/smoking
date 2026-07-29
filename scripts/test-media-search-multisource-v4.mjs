import assert from 'node:assert/strict';
import { handleMultiSourceMediaSearchV4 } from '../worker/src/media-search-multisource-v4.js';

const originalFetch = globalThis.fetch;

try {
  let groundingCalls = 0;
  let reviewCalls = 0;
  let wikimediaSearches = 0;
  let openverseSearches = 0;
  let wellcomeSearches = 0;
  let openverseFailures = 0;
  let openverseGoodLoads = 0;
  let wellcomeImageLoads = 0;
  let wellcomeInfoJsonLoads = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(options.body);
      if (Array.isArray(body.tools)) {
        groundingCalls += 1;
        assert.deepEqual(body.tools, [{ google_search: {} }]);
        return geminiResponse({
          visualBrief: 'A biochemical pathway diagram showing tyrosinase converting tyrosine through DOPA to melanin, with the blocked step in albinism.',
          keyConcepts: ['tyrosinase', 'tyrosine', 'DOPA', 'melanin', 'albinism'],
          expectedVisualFeatures: ['tyrosinase enzyme step', 'DOPA intermediate', 'melanin product', 'blocked pathway in albinism'],
          firstSearchQuery: 'tyrosinase DOPA melanin albinism pathway diagram'
        }, {
          webSearchQueries: ['tyrosinase DOPA melanin pathway'],
          groundingChunks: [{ web: { title: 'Medical reference', uri: 'https://example.org/reference' } }]
        });
      }

      reviewCalls += 1;
      const prompt = body.contents[0].parts[0]?.text || '';
      assert.match(prompt, /Judge only the visible pixels/);
      assert.doesNotMatch(prompt, /Wikimedia misleading title/);
      assert.doesNotMatch(prompt, /Openverse relevant title/);
      assert.doesNotMatch(prompt, /Wellcome relevant title/);
      const inlineImages = body.contents[0].parts.filter((part) => part.inlineData);
      assert.equal(inlineImages.length, 3, 'Every review cycle must contain one successfully loaded image from each available provider.');

      const sourceOrder = rotatedSourceOrder(reviewCalls, 1);
      return geminiResponse({
        decisions: sourceOrder.map((source, index) => source === 'Wikimedia Commons'
          ? {
              index,
              accept: true,
              labelMatch: true,
              resemblanceScore: 99,
              visualCoverage: 99,
              matchedFeatures: ['tyrosinase step', 'melanin label'],
              missingRequiredFeatures: [],
              contradictions: ['The visible pathway is a different biochemical process.'],
              reason: 'High superficial similarity, but the pixels contradict the requested pathway.'
            }
          : {
              index,
              accept: true,
              labelMatch: true,
              resemblanceScore: source === 'Openverse' ? 94 : 92,
              visualCoverage: 90,
              matchedFeatures: ['tyrosinase enzyme step', 'DOPA intermediate', 'melanin product'],
              missingRequiredFeatures: [],
              contradictions: [],
              reason: 'The visible pathway directly matches the requested albinism mechanism.'
            }),
        nextQuery: `alternative tyrosinase pathway query ${reviewCalls + 1}`
      });
    }

    if (value.startsWith('https://commons.wikimedia.org/w/api.php?')) {
      wikimediaSearches += 1;
      return wikimediaResponse(wikimediaSearches);
    }

    if (value.startsWith('https://api.openverse.org/v1/images/?')) {
      openverseSearches += 1;
      return openverseResponse(openverseSearches);
    }

    if (value.startsWith('https://api.wellcomecollection.org/catalogue/v2/images?')) {
      wellcomeSearches += 1;
      return wellcomeResponse(wellcomeSearches);
    }

    if (value.includes('/info.json')) {
      wellcomeInfoJsonLoads += 1;
      return Response.json({ error: 'The engine must convert info.json into an IIIF image URL.' });
    }

    if (value.includes('openverse.test/bad-')) {
      openverseFailures += 1;
      return new Response('unavailable', { status: 503 });
    }

    if (value.includes('openverse.test/good-')) {
      openverseGoodLoads += 1;
      return imageResponse('image/jpeg');
    }

    if (value.includes('iiif.wellcome.test/') && value.includes('/full/!512,512/0/default.jpg')) {
      wellcomeImageLoads += 1;
      return imageResponse('image/jpeg');
    }

    if (value.startsWith('https://upload.wikimedia.test/')) {
      return imageResponse('image/png');
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  const response = await handleMultiSourceMediaSearchV4(new Request('https://example.com/api/search', {
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
      ],
      searchRun: 1,
      excludedUrls: []
    })
  }), { GEMINI_API_KEY: 'test-key' });

  assert.ok(response);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.engine, 'multi-source-v4');
  assert.equal(payload.searchRounds, 5, 'The search should reach five accepted images and then run two additional cycles.');
  assert.equal(payload.stoppedReason, 'minimum-plus-two-cycles');
  assert.equal(payload.sourceCounts.Openverse, 5);
  assert.equal(payload.sourceCounts['Wellcome Collection'], 5);
  assert.equal(payload.sourceCounts['Wikimedia Commons'] || 0, 0, 'Contradictory Wikimedia images must be rejected even when Gemini gives them a high score.');
  assert.ok(payload.imageResults.every((item) => item.source !== 'Wikimedia Commons'));
  assert.ok(payload.imageResults.every((item) => item.visualCoverage >= 75));
  assert.ok(payload.imageResults.every((item) => item.matchedFeatures.length >= 2));

  assert.equal(groundingCalls, 1);
  assert.equal(reviewCalls, 5);
  assert.equal(wikimediaSearches, 5);
  assert.equal(openverseSearches, 5);
  assert.equal(wellcomeSearches, 5);
  assert.equal(wellcomeInfoJsonLoads, 0);
  assert.equal(wellcomeImageLoads, 5);
  assert.ok(openverseFailures >= 10, 'Both the thumbnail and original for the first Openverse candidate should fail before backfill.');
  assert.equal(openverseGoodLoads, 5);

  assert.equal(payload.providerDiagnostics.Openverse.loaded, 5);
  assert.equal(payload.providerDiagnostics.Openverse.reviewed, 5);
  assert.equal(payload.providerDiagnostics.Openverse.accepted, 5);
  assert.ok(payload.providerDiagnostics.Openverse.loadAttempts >= 10);
  assert.equal(payload.providerDiagnostics['Wellcome Collection'].loaded, 5);
  assert.equal(payload.providerDiagnostics['Wellcome Collection'].accepted, 5);
  assert.equal(payload.providerDiagnostics['Wikimedia Commons'].loaded, 5);
  assert.equal(payload.providerDiagnostics['Wikimedia Commons'].rejected, 5);

  console.log('Strict source-balanced visual media search validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function rotatedSourceOrder(cycle, searchRun) {
  const sources = ['Wikimedia Commons', 'Openverse', 'Wellcome Collection'];
  const shift = Math.abs((cycle - 1) + searchRun) % sources.length;
  return [...sources.slice(shift), ...sources.slice(0, shift)];
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
  return Response.json({
    query: {
      pages: {
        1: {
          pageid: cycle,
          title: `File:Wikimedia misleading title ${cycle}.png`,
          imageinfo: [{
            mime: 'image/png',
            url: `https://upload.wikimedia.test/wiki-${cycle}.png`,
            thumburl: `https://upload.wikimedia.test/wiki-${cycle}-thumb.png`,
            extmetadata: {
              ImageDescription: { value: 'Misleading metadata containing tyrosinase and melanin.' },
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

function openverseResponse(cycle) {
  return Response.json({
    results: [
      {
        id: `bad-${cycle}`,
        title: `Openverse unavailable candidate ${cycle}`,
        thumbnail: `https://thumb.openverse.test/bad-${cycle}.jpg`,
        url: `https://images.openverse.test/bad-${cycle}.jpg`,
        creator: 'Openverse creator',
        license: 'by-nc',
        license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        foreign_landing_url: `https://example.org/openverse/bad-${cycle}`
      },
      {
        id: `good-${cycle}`,
        title: `Openverse relevant title ${cycle}`,
        thumbnail: `https://thumb.openverse.test/good-${cycle}.jpg`,
        url: `https://images.openverse.test/good-${cycle}.jpg`,
        creator: 'Openverse creator',
        license: 'by-nc',
        license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        attribution: `Openverse pathway ${cycle} — Openverse creator — CC BY-NC 4.0`,
        foreign_landing_url: `https://example.org/openverse/good-${cycle}`,
        tags: [{ name: 'tyrosinase' }, { name: 'melanin' }]
      }
    ]
  });
}

function wellcomeResponse(cycle) {
  return Response.json({
    results: [{
      id: `wellcome-${cycle}`,
      source: {
        id: `work-${cycle}`,
        title: `Wellcome relevant title ${cycle}`,
        description: 'Medical pathway illustration',
        contributors: [{ agent: { label: 'Wellcome artist' } }],
        subjects: [{ label: 'Melanin' }],
        genres: [{ label: 'Medical illustration' }],
        license: {
          id: 'cc-by-nc-4.0',
          label: 'CC BY-NC 4.0',
          url: 'https://creativecommons.org/licenses/by-nc/4.0/'
        },
        locations: [{
          url: `https://iiif.wellcome.test/image-${cycle}/info.json`,
          credit: `Wellcome pathway ${cycle} — Wellcome Collection — CC BY-NC 4.0`
        }]
      }
    }]
  });
}

function imageResponse(contentType) {
  return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
    headers: { 'content-type': contentType, 'content-length': '8' }
  });
}

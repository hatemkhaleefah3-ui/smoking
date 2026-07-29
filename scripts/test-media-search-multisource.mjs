import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  const providerQueries = { wikimedia: [], openverse: [], wellcome: [] };
  let groundingCalls = 0;
  let reviewCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
      if (Array.isArray(body.tools)) {
        groundingCalls += 1;
        assert.deepEqual(body.tools, [{ google_search: {} }]);
        assert.match(body.contents[0].parts[0].text, /Wikimedia Commons, Openverse, and Wellcome Collection/);
        return geminiResponse({
          visualBrief: 'A melanin synthesis pathway showing tyrosine, DOPA, tyrosinase, and the blocked step in albinism.',
          keyConcepts: ['melanin synthesis', 'tyrosinase', 'DOPA', 'albinism'],
          expectedVisualFeatures: ['tyrosine to DOPA arrow', 'melanin product', 'blocked tyrosinase step'],
          firstSearchQuery: 'tyrosinase melanin albinism pathway'
        }, {
          webSearchQueries: ['melanin synthesis albinism diagram'],
          groundingChunks: [{ web: { title: 'Medical reference', uri: 'https://example.org/reference' } }]
        });
      }

      reviewCalls += 1;
      const parts = body.contents[0].parts;
      const images = parts.filter((part) => part.inlineData);
      assert.equal(images.length, 4, 'Each cycle must review four source-balanced thumbnails to stay within the Worker subrequest budget.');
      const prompt = parts[0].text;
      assert.match(prompt, /Openverse/);
      assert.match(prompt, /Wellcome Collection/);
      assert.match(prompt, /license/);

      if (reviewCalls === 1) {
        return geminiResponse({
          decisions: [decision(0, true, 98), decision(1, true, 94), decision(2, true, 92), decision(3, true, 88)],
          nextQuery: 'melanogenesis tyrosinase deficiency diagram'
        });
      }
      if (reviewCalls === 2) {
        return geminiResponse({
          decisions: [decision(0, true, 96), decision(1, true, 90), decision(2, false, 20), decision(3, false, 15)],
          nextQuery: 'oculocutaneous albinism melanin pathway'
        });
      }
      if (reviewCalls === 3) {
        return geminiResponse({
          decisions: [decision(0, false, 25), decision(1, false, 20), decision(2, true, 91), decision(3, false, 10)],
          nextQuery: 'tyrosinase blocked biochemical pathway'
        });
      }
      if (reviewCalls === 4) {
        return geminiResponse({
          decisions: [decision(0, false, 25), decision(1, false, 20), decision(2, false, 15), decision(3, true, 89)],
          nextQuery: 'unused fifth query'
        });
      }
      throw new Error(`Unexpected Gemini review call ${reviewCalls}`);
    }

    if (value.startsWith('https://commons.wikimedia.org/w/api.php?')) {
      const query = new URL(value).searchParams.get('gsrsearch') || '';
      providerQueries.wikimedia.push(query);
      return commonsResponse(providerQueries.wikimedia.length);
    }

    if (value.startsWith('https://api.openverse.org/v1/images/?')) {
      const parsed = new URL(value);
      providerQueries.openverse.push(parsed.searchParams.get('q') || '');
      assert.equal(parsed.searchParams.get('excluded_source'), 'wikimedia');
      const licenses = parsed.searchParams.get('license') || '';
      assert.match(licenses, /by-nc/);
      assert.match(licenses, /by-nc-sa/);
      assert.doesNotMatch(licenses, /by-nc-nd/);
      return openverseResponse(providerQueries.openverse.length);
    }

    if (value.startsWith('https://api.wellcomecollection.org/catalogue/v2/images?')) {
      const parsed = new URL(value);
      providerQueries.wellcome.push(parsed.searchParams.get('query') || '');
      return wellcomeResponse(providerQueries.wellcome.length);
    }

    if (value.startsWith('https://upload.wikimedia.org/')
      || value.startsWith('https://api.openverse.org/v1/images/')
      || value.startsWith('https://iiif.wellcomecollection.org/')) {
      return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
        headers: { 'content-type': 'image/png', 'content-length': '8' }
      });
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  const response = await worker.fetch(new Request('https://example.com/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({
      intentSearch: true,
      strictRelevance: true,
      imageId: 'img-albinism',
      label: 'Albinism pathway block',
      altTexts: [
        'Diagram showing tyrosinase-dependent conversion of tyrosine through DOPA to melanin.',
        'Pathway illustrating phenylalanine and tyrosine metabolism in albinism.'
      ]
    })
  }), { GEMINI_API_KEY: 'test-key' });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(groundingCalls, 1);
  assert.equal(reviewCalls, 4, 'The first five accepted images must be followed by exactly two additional collection cycles.');
  assert.equal(payload.multiSource, true);
  assert.equal(payload.googleSearchGrounding, true);
  assert.equal(payload.stoppedReason, 'minimum-plus-two-cycles');
  assert.equal(payload.searchRounds, 4);
  assert.equal(payload.usefulCount, 8);
  assert.equal(payload.imageResults.length, 8);
  assert.deepEqual(payload.images, payload.imageResults.map((item) => item.url));
  assert.ok(payload.allowedLicenses.includes('CC BY-NC'));
  assert.ok(payload.allowedLicenses.includes('CC BY-NC-SA'));
  assert.equal(providerQueries.wikimedia.length, 4);
  assert.deepEqual(providerQueries.wikimedia, providerQueries.openverse);
  assert.deepEqual(providerQueries.wikimedia, providerQueries.wellcome);

  const sources = new Set(payload.imageResults.map((item) => item.source));
  assert.deepEqual([...sources].sort(), ['Openverse', 'Wellcome Collection', 'Wikimedia Commons']);
  const openverse = payload.imageResults.find((item) => item.source === 'Openverse');
  assert.match(openverse.license, /CC BY-NC/);
  assert.match(openverse.attribution, /Student Illustrator/);
  assert.match(openverse.sourcePage, /openverse-source/);
  const wellcome = payload.imageResults.find((item) => item.source === 'Wellcome Collection');
  assert.equal(wellcome.license, 'CC BY-NC');
  assert.match(wellcome.attribution, /Wellcome credit/);
  assert.ok(payload.imageResults.every((item) => !/ND|In copyright/i.test(item.license)));
  assert.ok(payload.imageResults.every((item) => item.sourcePage && item.attribution && item.license));

  console.log('Licensed Wikimedia, Openverse, and Wellcome visual search validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function decision(index, resembles, resemblanceScore) {
  return { index, resembles, resemblanceScore, reason: resembles ? 'Visible pathway matches.' : 'Does not resemble the intended pathway.' };
}

function geminiResponse(value, groundingMetadata) {
  return Response.json({
    candidates: [{
      content: { parts: [{ text: JSON.stringify(value) }] },
      ...(groundingMetadata ? { groundingMetadata } : {})
    }]
  });
}

function commonsResponse(cycle) {
  const pages = {};
  for (let index = 0; index < 2; index += 1) {
    const title = `commons-cycle-${cycle}-${index + 1}.png`;
    pages[index + 1] = {
      pageid: cycle * 10 + index,
      title: `File:${title}`,
      imageinfo: [{
        mime: 'image/png',
        url: `https://upload.wikimedia.org/${title}`,
        thumburl: `https://upload.wikimedia.org/thumb/${title}`,
        extmetadata: {
          ImageDescription: { value: '<p>Medical pathway diagram</p>' },
          Artist: { value: 'Commons Author' },
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
        title: `Openverse pathway ${cycle}`,
        creator: 'Student Illustrator',
        creator_url: 'https://example.org/creator',
        url: `https://example.org/openverse-original-${cycle}.png`,
        thumbnail: `https://api.openverse.org/v1/images/openverse-${cycle}/thumb/`,
        license: 'by-nc',
        license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
        attribution: `Openverse pathway ${cycle} by Student Illustrator — CC BY-NC 4.0`,
        foreign_landing_url: `https://example.org/openverse-source-${cycle}`,
        tags: [{ name: 'melanin' }, { name: 'pathway' }]
      },
      {
        id: `forbidden-${cycle}`,
        title: 'No derivatives result',
        url: `https://example.org/forbidden-${cycle}.png`,
        thumbnail: `https://api.openverse.org/v1/images/forbidden-${cycle}/thumb/`,
        license: 'by-nc-nd',
        license_version: '4.0',
        foreign_landing_url: `https://example.org/forbidden-source-${cycle}`
      }
    ]
  });
}

function wellcomeResponse(cycle) {
  return Response.json({
    results: [
      {
        id: `wellcome-${cycle}`,
        thumbnail: {
          url: `https://iiif.wellcomecollection.org/image/wellcome-${cycle}/full/512,/0/default.jpg`,
          credit: `Wellcome credit ${cycle}`,
          license: {
            id: 'cc-by-nc',
            label: 'CC BY-NC 4.0',
            url: 'https://creativecommons.org/licenses/by-nc/4.0/'
          }
        },
        source: {
          id: `work-${cycle}`,
          title: `Wellcome melanin pathway ${cycle}`,
          contributors: [{ agent: { label: 'Medical Artist' } }],
          subjects: [{ label: 'Albinism' }],
          genres: [{ label: 'Medical diagrams' }]
        }
      },
      {
        id: `restricted-${cycle}`,
        thumbnail: {
          url: `https://iiif.wellcomecollection.org/image/restricted-${cycle}/full/512,/0/default.jpg`,
          license: { id: 'inc', label: 'In copyright' }
        },
        source: { id: `restricted-work-${cycle}`, title: 'Restricted image' }
      }
    ]
  });
}
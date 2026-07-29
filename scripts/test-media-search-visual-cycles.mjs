import assert from 'node:assert/strict';
import { handleVisualCycleMediaSearch } from '../worker/src/media-search-visual-cycles.js';

const originalFetch = globalThis.fetch;

try {
  const commonsQueries = [];
  let groundingCalls = 0;
  let reviewCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
      assert.equal(body.generationConfig.responseFormat.text.schema.type, 'object');

      if (Array.isArray(body.tools)) {
        groundingCalls += 1;
        assert.deepEqual(body.tools, [{ google_search: {} }]);
        const prompt = body.contents[0].parts[0].text;
        assert.match(prompt, /Use Google Search grounding before answering/);
        assert.match(prompt, /tyrosinase-dependent conversion/);
        return geminiResponse({
          visualBrief: 'A biochemical diagram of tyrosine to DOPA to melanin, highlighting a tyrosinase block in albinism.',
          keyConcepts: ['tyrosinase', 'melanin synthesis', 'DOPA', 'albinism'],
          expectedVisualFeatures: ['tyrosine to DOPA arrow', 'melanin product', 'blocked tyrosinase step'],
          firstWikimediaQuery: 'tyrosinase melanin albinism pathway'
        }, {
          webSearchQueries: ['tyrosinase melanin pathway diagram'],
          groundingChunks: [{ web: { title: 'Biochemistry reference', uri: 'https://example.org/melanin' } }]
        });
      }

      reviewCalls += 1;
      const prompt = body.contents[0].parts[0].text;
      assert.match(prompt, /Inspect the actual candidate images/);
      const images = body.contents[0].parts.filter((part) => part.inlineData);
      assert.equal(images.length, 6, 'Each cycle should visually inspect six Wikimedia thumbnails.');
      for (const image of images) {
        assert.equal(image.inlineData.mimeType, 'image/png');
        assert.ok(image.inlineData.data.length > 0);
      }

      if (reviewCalls === 1) {
        return geminiResponse({
          decisions: [
            decision(0, true, 98), decision(1, true, 94), decision(2, true, 90),
            decision(3, true, 86), decision(4, true, 82), decision(5, false, 20)
          ],
          nextQuery: 'melanogenesis tyrosinase deficiency diagram'
        });
      }
      if (reviewCalls === 2) {
        return geminiResponse({
          decisions: [
            decision(0, true, 96), decision(1, true, 88), decision(2, false, 25),
            decision(3, false, 20), decision(4, false, 15), decision(5, false, 10)
          ],
          nextQuery: 'oculocutaneous albinism melanin pathway'
        });
      }
      if (reviewCalls === 3) {
        return geminiResponse({
          decisions: [
            decision(0, true, 92), decision(1, false, 30), decision(2, false, 25),
            decision(3, false, 20), decision(4, false, 15), decision(5, false, 10)
          ],
          nextQuery: 'unused fourth query'
        });
      }
      throw new Error(`Unexpected visual review call ${reviewCalls}.`);
    }

    if (value.startsWith('https://commons.wikimedia.org/w/api.php?')) {
      const query = new URL(value).searchParams.get('gsrsearch') || '';
      commonsQueries.push(query);
      return commonsResponse(commonsQueries.length);
    }

    if (value.startsWith('https://upload.wikimedia.org/')) {
      return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
        headers: { 'content-type': 'image/png', 'content-length': '8' }
      });
    }

    throw new Error(`Unexpected fetch URL: ${value}`);
  };

  const response = await handleVisualCycleMediaSearch(new Request('https://example.com/api/search', {
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
  assert.equal(reviewCalls, 3, 'Five accepted images should trigger exactly two additional cycles.');
  assert.deepEqual(commonsQueries, [
    'tyrosinase melanin albinism pathway',
    'melanogenesis tyrosinase deficiency diagram',
    'oculocutaneous albinism melanin pathway'
  ]);
  assert.equal(payload.googleSearchGrounding, true);
  assert.deepEqual(payload.groundingQueries, ['tyrosinase melanin pathway diagram']);
  assert.equal(payload.groundingSources[0].title, 'Biochemistry reference');
  assert.equal(payload.searchRounds, 3);
  assert.equal(payload.stoppedReason, 'minimum-plus-two-cycles');
  assert.equal(payload.usefulCount, 8);
  assert.equal(payload.targetReached, true);
  assert.equal(payload.images.length, 8);
  assert.match(decodeURIComponent(payload.images[0]), /cycle-1-image-1/);
  assert.equal(payload.cycles[0].accepted, 5);
  assert.equal(payload.cycles[2].totalAccepted, 8);

  console.log('Grounded six-cycle visual Wikimedia search validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function decision(index, resembles, resemblanceScore) {
  return { index, resembles, resemblanceScore, reason: resembles ? 'Visible pathway matches.' : 'Does not show the intended pathway.' };
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
  for (let index = 0; index < 6; index += 1) {
    const title = `cycle-${cycle}-image-${index + 1}.png`;
    pages[index + 1] = {
      title: `File:${title}`,
      imageinfo: [{
        mime: 'image/png',
        url: `https://upload.wikimedia.org/${title}`,
        thumburl: `https://upload.wikimedia.org/thumb/${title}`,
        extmetadata: {
          ImageDescription: { value: `<p>${title} medical pathway</p>` },
          ObjectName: { value: title }
        }
      }]
    };
  }
  return Response.json({ query: { pages } });
}

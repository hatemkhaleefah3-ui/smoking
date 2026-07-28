import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  await validateOrderedAltTextFlow();
  await validateLabelFallbackFlow();
  console.log('Ordered alt-text Wikimedia search validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

async function validateOrderedAltTextFlow() {
  const altTexts = [
    'Diagram showing tyrosinase-dependent conversion of tyrosine through DOPA to melanin.',
    'Pathway illustrating phenylalanine and tyrosine metabolism in albinism.'
  ];
  const expectedQueries = [
    'Diagram showing',
    altTexts[0],
    'Pathway illustrating',
    altTexts[1]
  ];
  const commonsQueries = [];
  let geminiCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
      assert.equal(body.generationConfig.responseFormat.text.schema.type, 'object');
      const prompt = body.contents[0].parts[0].text;

      if (geminiCalls === 1) {
        assert.match(prompt, /Diagram showing tyrosinase-dependent/);
        assert.match(prompt, /Pathway illustrating phenylalanine/);
        assert.match(prompt, /Do not create search queries in this step/);
        return geminiResult({
          intentSummary: 'Melanin synthesis and albinism pathway.',
          keyConcepts: ['melanin synthesis', 'tyrosinase', 'albinism']
        });
      }

      assert.equal(commonsQueries.length, expectedQueries.length, 'Ranking must happen only after every alt-text search finishes.');
      assert.match(prompt, /visible image label is the primary ranking target/i);
      return geminiResult({
        rankedCandidates: [
          { index: 0, usefulness: 40 },
          { index: 1, usefulness: 91 },
          { index: 2, usefulness: 70 },
          { index: 3, usefulness: 98 }
        ]
      });
    }

    assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
    assert.match(options.headers['User-Agent'], /^LecturePublisherIntentSearch\/1\.1 /);
    const term = new URL(value).searchParams.get('gsrsearch') || '';
    commonsQueries.push(term);
    const title = [
      'General diagram.jpg',
      'Tyrosinase melanin pathway.svg',
      'Phenylalanine metabolism.svg',
      'Albinism pathway block.svg'
    ][commonsQueries.length - 1];
    return commonsResponse(title);
  };

  const response = await worker.fetch(intentRequest({
    intentSearch: true,
    imageId: 'img-albinism',
    label: 'Albinism pathway block',
    altTexts
  }), { GEMINI_API_KEY: 'test-key' });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(commonsQueries, expectedQueries);
  assert.deepEqual(payload.searchedQueries, expectedQueries);
  assert.equal(payload.searchRounds, 4);
  assert.equal(payload.labelFallbackUsed, false);
  assert.equal(payload.images.length, 4, 'Every unique image collected from the ordered searches should remain visible.');
  assert.match(decodeURIComponent(payload.images[0]), /Albinism pathway block/);
  assert.match(decodeURIComponent(payload.images[1]), /Tyrosinase melanin pathway/);
  assert.match(decodeURIComponent(payload.images[2]), /Phenylalanine metabolism/);
  assert.match(decodeURIComponent(payload.images[3]), /General diagram/);
  assert.equal(geminiCalls, 2, 'The normal path should use one understanding call and one ranking call.');
}

async function validateLabelFallbackFlow() {
  const altTexts = ['Uncatalogued illustration for a rare lecture concept.'];
  const commonsQueries = [];
  let geminiCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      geminiCalls += 1;
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;

      if (geminiCalls === 1) {
        return geminiResult({
          intentSummary: 'A rare enzyme pathway lecture illustration.',
          keyConcepts: ['rare enzyme pathway']
        });
      }
      if (geminiCalls === 2) {
        assert.match(prompt, /No Wikimedia Commons images were found/);
        assert.match(prompt, /Rare enzyme pathway label/);
        return geminiResult({
          searchQueries: ['rare enzyme pathway diagram', 'special enzyme lecture illustration']
        });
      }
      return geminiResult({
        rankedCandidates: [
          { index: 0, usefulness: 72 },
          { index: 1, usefulness: 94 }
        ]
      });
    }

    const term = new URL(value).searchParams.get('gsrsearch') || '';
    commonsQueries.push(term);
    if (commonsQueries.length <= 2) return commonsResponse();
    if (term === 'rare enzyme pathway diagram') return commonsResponse('Rare enzyme pathway.svg');
    if (term === 'special enzyme lecture illustration') return commonsResponse('Special enzyme lecture illustration.svg');
    throw new Error(`Unexpected Commons query: ${term}`);
  };

  const response = await worker.fetch(intentRequest({
    intentSearch: true,
    imageId: 'img-rare-enzyme',
    label: 'Rare enzyme pathway label',
    altTexts
  }), { GEMINI_API_KEY: 'test-key' });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(commonsQueries, [
    'Uncatalogued illustration',
    altTexts[0],
    'rare enzyme pathway diagram',
    'special enzyme lecture illustration'
  ]);
  assert.equal(payload.labelFallbackUsed, true);
  assert.equal(payload.images.length, 2);
  assert.match(decodeURIComponent(payload.images[0]), /Special enzyme lecture illustration/);
  assert.match(decodeURIComponent(payload.images[1]), /Rare enzyme pathway/);
  assert.equal(geminiCalls, 3);
}

function intentRequest(body) {
  return new Request('https://example.com/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify(body)
  });
}

function geminiResult(value) {
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }]
  });
}

function commonsResponse(...titles) {
  if (titles.length === 0) return Response.json({ query: { pages: {} } });
  return Response.json({
    query: {
      pages: Object.fromEntries(titles.map((title, index) => [
        index + 1,
        {
          title: `File:${title}`,
          imageinfo: [{
            mime: title.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg',
            url: `https://upload.wikimedia.org/${encodeURIComponent(title)}`,
            thumburl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title)}/900px-${encodeURIComponent(title)}`,
            extmetadata: {
              ImageDescription: { value: `<p>${title} medical illustration</p>` },
              Categories: { value: 'Biochemistry|Medical diagrams' }
            }
          }]
        }
      ]))
    }
  });
}

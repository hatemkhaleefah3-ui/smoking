import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  const altTexts = [
    'Diagram showing tyrosinase-dependent conversion of tyrosine through DOPA to melanin, blocked in albinism.',
    'Pathway illustrating phenylalanine, tyrosine, DOPA, melanin synthesis, and tyrosinase deficiency.'
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
        assert.match(prompt, /tyrosinase-dependent conversion/);
        assert.match(prompt, /phenylalanine, tyrosine, DOPA/);
        return geminiResult({
          intentSummary: 'Melanin synthesis pathway and the tyrosinase block responsible for albinism.',
          keyConcepts: ['melanin synthesis', 'tyrosinase deficiency', 'DOPA', 'albinism'],
          searchQueries: [
            'tyrosinase melanin pathway',
            'DOPA melanin synthesis',
            'albinism biochemical pathway',
            'tyrosine melanogenesis diagram',
            'melanin biosynthesis pathway',
            'tyrosinase deficiency diagram'
          ]
        });
      }

      if (geminiCalls === 2) {
        return geminiResult({
          rankedCandidates: [
            { index: 0, usefulness: 96 },
            { index: 1, usefulness: 78 },
            { index: 2, usefulness: 18 }
          ],
          nextQueries: ['oculocutaneous albinism melanin pathway']
        });
      }

      if (geminiCalls === 3) {
        return geminiResult({
          rankedCandidates: [
            { index: 0, usefulness: 96 },
            { index: 1, usefulness: 78 },
            { index: 2, usefulness: 18 },
            { index: 3, usefulness: 91 },
            { index: 4, usefulness: 45 },
            { index: 5, usefulness: 35 }
          ],
          nextQueries: []
        });
      }

      throw new Error(`Unexpected Gemini call ${geminiCalls}.`);
    }

    assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
    assert.match(options.headers['User-Agent'], /^LecturePublisherIntentSearch\/1\.0 /);
    const term = new URL(value).searchParams.get('gsrsearch') || '';
    commonsQueries.push(term);
    const titles = [
      'Tyrosinase melanin pathway.svg',
      'DOPA melanin synthesis.svg',
      'Unrelated portrait.jpg',
      'Albinism pathway diagram.svg',
      'Melanocyte anatomy.jpg',
      'Phenylalanine structure.svg'
    ];
    return commonsResponse(titles[commonsQueries.length - 1]);
  };

  const response = await worker.fetch(intentRequest({
    intentSearch: true,
    imageId: 'img-albinism',
    label: 'Albinism pathway block',
    altTexts
  }), { GEMINI_API_KEY: 'test-key' });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.targetReached, true);
  assert.ok(payload.usefulCount >= 3);
  assert.equal(payload.searchRounds, 2);
  assert.equal(geminiCalls, 3, 'One understanding call and two ranking calls should be enough.');
  assert.equal(commonsQueries.length, 6, 'The search should continue into a second round before reaching three useful images.');
  assert.match(decodeURIComponent(payload.images[0]), /Tyrosinase melanin pathway/);
  assert.match(decodeURIComponent(payload.images[1]), /Albinism pathway diagram/);
  assert.match(decodeURIComponent(payload.images[2]), /DOPA melanin synthesis/);

  console.log('Iterative Gemini image-intent search validation passed.');
} finally {
  globalThis.fetch = originalFetch;
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

function commonsResponse(title) {
  return Response.json({
    query: {
      pages: {
        1: {
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
      }
    }
  });
}

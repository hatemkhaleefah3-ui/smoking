import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch should not run'); };
  const emptyResponse = await worker.fetch(request({ query: '   ' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(emptyResponse.status, 400);
  assert.equal(fetchCalls, 0);

  // Attempt 1 succeeds and stops immediately after generation, Wikimedia search,
  // and title relevance validation.
  const earlyCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    earlyCalls.push(value);
    if (value.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      if (prompt.includes('You generate Wikimedia Commons search phrases')) {
        assert.match(prompt, /Original user input: Glycolysis/);
        assert.match(prompt, /Preserve the user’s core intent exactly/);
        return geminiJson({ searchTerm: 'glycolysis pathway', intentSummary: 'glycolysis metabolic pathway' });
      }
      assert.match(prompt, /Candidate file titles/);
      return geminiJson({ relevantIndexes: [0, 1] });
    }
    assertCommonsRequest(url, options);
    return commonsResponse(
      ['File:Glycolysis pathway overview.svg', 'glycolysis-one.svg'],
      ['File:Glycolysis enzymes diagram.png', 'glycolysis-two.png']
    );
  };
  const earlyResponse = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(earlyResponse.status, 200);
  assert.equal(earlyCalls.length, 3);
  assert.deepEqual(await earlyResponse.json(), {
    images: [
      'https://upload.wikimedia.org/thumb/glycolysis-one.svg/900px-glycolysis-one.svg',
      'https://upload.wikimedia.org/thumb/glycolysis-two.png/900px-glycolysis-two.png'
    ]
  });

  // Attempt 1 returns irrelevant junk, attempt 2 returns zero results, and attempt
  // 3 succeeds with a distinct academic synonym while preserving the same concept.
  const generationPrompts = [];
  const variationTerms = ['glycolysis', 'Embden Meyerhof pathway', 'glycolytic pathway diagram'];
  let variationIndex = 0;
  let commonsIndex = 0;
  let evaluationIndex = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      if (prompt.includes('You generate Wikimedia Commons search phrases')) {
        generationPrompts.push(prompt);
        const term = variationTerms[variationIndex++];
        return geminiJson({ searchTerm: term, intentSummary: 'glycolysis metabolic pathway' });
      }
      evaluationIndex += 1;
      return evaluationIndex === 1
        ? geminiJson({ relevantIndexes: [] })
        : geminiJson({ relevantIndexes: [0, 1, 2] });
    }

    commonsIndex += 1;
    assertCommonsRequest(url, options);
    if (commonsIndex === 1) {
      return commonsResponse(
        ['File:Butterfly stone plaque.jpg', 'butterfly.jpg'],
        ['File:Ancient decorative tablet.jpg', 'plaque.jpg']
      );
    }
    if (commonsIndex === 2) return commonsResponse();
    return commonsResponse(
      ['File:Glycolysis metabolic pathway.svg', 'glycolysis-pathway.svg'],
      ['File:Embden Meyerhof pathway diagram.png', 'embden.png'],
      ['File:Glycolysis reactions chart.jpg', 'glycolysis-reactions.jpg']
    );
  };

  const retryResponse = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(retryResponse.status, 200);
  assert.equal(generationPrompts.length, 3);
  assert.match(generationPrompts[1], /Previously tried phrases/);
  assert.match(generationPrompts[1], /glycolysis/);
  assert.match(generationPrompts[1], /Butterfly stone plaque/);
  assert.match(generationPrompts[2], /Embden Meyerhof pathway/);
  assert.deepEqual((await retryResponse.json()).images, [
    'https://upload.wikimedia.org/thumb/glycolysis-pathway.svg/900px-glycolysis-pathway.svg',
    'https://upload.wikimedia.org/thumb/embden.png/900px-embden.png',
    'https://upload.wikimedia.org/thumb/glycolysis-reactions.jpg/900px-glycolysis-reactions.jpg'
  ]);

  // Three failed intelligent variations return an empty image list, allowing the
  // existing frontend to show its friendly “No images found” message.
  let failedGeneration = 0;
  let failedCommons = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('You generate Wikimedia Commons search phrases')) {
        failedGeneration += 1;
        return geminiJson({ searchTerm: `exact concept variation ${failedGeneration}`, intentSummary: 'same exact concept' });
      }
      throw new Error('No relevance evaluation should run for zero candidates.');
    }
    failedCommons += 1;
    assertCommonsRequest(url, options);
    return commonsResponse();
  };
  const noResultsResponse = await worker.fetch(request({ query: 'Unfindable concept' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(failedGeneration, 3);
  assert.equal(failedCommons, 3);
  assert.deepEqual(await noResultsResponse.json(), { images: [] });

  // Missing Gemini access searches the exact original phrase once and does not
  // fabricate alternative intent.
  let noKeyCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    noKeyCalls += 1;
    assertCommonsRequest(url, options);
    assert.match(String(url), /gsrsearch=heart\+symbol/);
    return commonsResponse(['File:Heart symbol.svg', 'heart-symbol.svg']);
  };
  const noKeyResponse = await worker.fetch(request({ query: 'heart symbol' }), {});
  assert.equal(noKeyCalls, 1);
  assert.equal((await noKeyResponse.json()).images.length, 1);

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return geminiJson({ searchTerm: 'glycolysis', intentSummary: 'glycolysis' });
    }
    assertCommonsRequest(url, options);
    return Response.json({ error: { code: 'baduseragent' } });
  };
  const upstreamError = await worker.fetch(request({ query: 'glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(upstreamError.status, 502);
  assert.deepEqual(await upstreamError.json(), { error: 'Something went wrong' });

  console.log('Iterative semantic media search validation passed.');
} finally {
  globalThis.fetch = originalFetch;
}

function request(body) {
  return new Request('https://example.com/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify(body)
  });
}

function geminiJson(value) {
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
}

function assertCommonsRequest(url, options) {
  const value = String(url);
  assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
  assert.match(value, /gsrlimit=12/);
  assert.match(value, /gsrnamespace=6/);
  assert.match(value, /iiprop=url%7Cmime/);
  assert.match(value, /iiurlwidth=900/);
  assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.5/);
}

function commonsResponse(...entries) {
  return Response.json({
    query: {
      pages: Object.fromEntries(entries.map(([title, filename], index) => [
        index + 1,
        {
          title,
          imageinfo: [{
            mime: filename.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg',
            url: `https://upload.wikimedia.org/${filename}`,
            thumburl: `https://upload.wikimedia.org/thumb/${filename}/900px-${filename}`
          }]
        }
      ]))
    }
  });
}

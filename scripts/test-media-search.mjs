import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch should not run'); };
  const emptyResponse = await worker.fetch(request({ query: '   ' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(emptyResponse.status, 400);
  assert.equal(fetchCalls, 0);

  // Current Gemini responseFormat is used and Attempt 1 stops immediately.
  let firstAttemptGeminiCalls = 0;
  let firstAttemptCommonsCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      firstAttemptGeminiCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
      assert.equal(body.generationConfig.responseFormat.text.schema.type, 'object');
      if (firstAttemptGeminiCalls === 1) {
        return geminiResult({ searchTerm: 'glycolysis', intentSummary: 'glycolysis' });
      }
      return geminiResult({ relevantIndexes: [0, 1] });
    }
    firstAttemptCommonsCalls += 1;
    assertCommonsRequest(url, options);
    return commonsResponse('Glycolysis pathway.svg', 'Glycolysis overview.png');
  };
  const firstAttempt = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(firstAttempt.status, 200);
  assert.equal(firstAttemptCommonsCalls, 1);
  assert.equal((await firstAttempt.json()).images.length, 2);

  // A Gemini variation failure must fall back to the exact input, not HTTP 502.
  let variationFailureCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    variationFailureCalls += 1;
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response('bad request', { status: 400 });
    }
    assertCommonsRequest(url, options);
    assert.match(String(url), /gsrsearch=Glycolysis/);
    return commonsResponse('Glycolysis diagram.svg');
  };
  const variationFailure = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(variationFailure.status, 200);
  assert.equal(variationFailureCalls, 2);
  assert.equal((await variationFailure.json()).images.length, 1);

  // A relevance-check failure also degrades to local title matching.
  let relevanceGeminiCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      relevanceGeminiCalls += 1;
      if (relevanceGeminiCalls === 1) {
        return geminiResult({ searchTerm: 'human heart', intentSummary: 'heart' });
      }
      return new Response('quota exceeded', { status: 429 });
    }
    assertCommonsRequest(url, options);
    return commonsResponse('Human heart anterior view.svg', 'Violin sheet music.png');
  };
  const relevanceFailure = await worker.fetch(request({ query: 'Heart' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(relevanceFailure.status, 200);
  assert.equal((await relevanceFailure.json()).images.length, 1);

  // Junk is rejected; the next semantic variation succeeds.
  let retryGeminiCalls = 0;
  let retryCommonsCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      retryGeminiCalls += 1;
      if (retryGeminiCalls === 1) return geminiResult({ searchTerm: 'glycolysis', intentSummary: 'glycolysis' });
      if (retryGeminiCalls === 2) return geminiResult({ relevantIndexes: [] });
      if (retryGeminiCalls === 3) return geminiResult({ searchTerm: 'Embden Meyerhof pathway', intentSummary: 'glycolysis' });
      return geminiResult({ relevantIndexes: [0, 1] });
    }
    retryCommonsCalls += 1;
    assertCommonsRequest(url, options);
    return retryCommonsCalls === 1
      ? commonsResponse('Blue butterfly.jpg', 'Stone plaque.jpg')
      : commonsResponse('Embden Meyerhof pathway.svg', 'Glycolysis reactions.png');
  };
  const retryResponse = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(retryResponse.status, 200);
  assert.equal(retryCommonsCalls, 2);
  assert.equal((await retryResponse.json()).images.length, 2);

  // Three successful Wikimedia searches with no accepted result return an empty list.
  let emptyGeminiCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      emptyGeminiCalls += 1;
      if (emptyGeminiCalls % 2 === 1) {
        return geminiResult({
          searchTerm: `term-${Math.ceil(emptyGeminiCalls / 2)}`,
          intentSummary: 'requested concept'
        });
      }
      return geminiResult({ relevantIndexes: [] });
    }
    assertCommonsRequest(url, options);
    return commonsResponse(`Unrelated ${emptyGeminiCalls}.jpg`);
  };
  const emptyResult = await worker.fetch(request({ query: 'rare exact concept' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(emptyResult.status, 200);
  assert.deepEqual(await emptyResult.json(), { images: [] });

  // Only a complete Wikimedia outage should return the generic error.
  let outageGeminiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      outageGeminiCalls += 1;
      return geminiResult({
        searchTerm: `outage-term-${outageGeminiCalls}`,
        intentSummary: 'same concept'
      });
    }
    return new Response('upstream unavailable', { status: 503 });
  };
  const outage = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(outage.status, 502);
  assert.deepEqual(await outage.json(), { error: 'Something went wrong' });

  console.log('Iterative media search runtime resilience validation passed.');
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

function geminiResult(value) {
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }]
  });
}

function assertCommonsRequest(url, options) {
  const value = String(url);
  assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
  assert.match(value, /gsrlimit=12/);
  assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.6 /);
}

function commonsResponse(...titles) {
  return Response.json({
    query: {
      pages: Object.fromEntries(titles.map((title, index) => [
        index + 1,
        {
          title: `File:${title}`,
          imageinfo: [{
            mime: title.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg',
            url: `https://upload.wikimedia.org/${encodeURIComponent(title)}`,
            thumburl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title)}/900px-${encodeURIComponent(title)}`
          }]
        }
      ]))
    }
  });
}

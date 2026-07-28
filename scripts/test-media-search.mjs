import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch should not run'); };
  const emptyResponse = await worker.fetch(request({ query: '   ' }), { GEMINI_API_KEY: 'test-key' }, {});
  assert.equal(emptyResponse.status, 400);
  assert.equal(fetchCalls, 0);

  const requestedUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    requestedUrls.push(String(url));
    if (String(url).includes('generativelanguage.googleapis.com')) {
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      return Response.json({ candidates: [{ content: { parts: [{ text: 'human heart anatomy' }] } }] });
    }
    return Response.json({
      query: {
        pages: {
          1: { imageinfo: [{ url: 'https://upload.wikimedia.org/heart-one.jpg' }] },
          2: { imageinfo: [{ url: 'https://upload.wikimedia.org/heart-two.jpg' }] },
          3: { imageinfo: [{ url: 'http://example.com/not-secure.jpg' }] }
        }
      }
    });
  };

  // No DB binding is provided: this proves /api/search is handled before the
  // lecture API's D1 initialization and cannot fall through to the old router.
  const successResponse = await worker.fetch(request({ query: 'hart anatomie' }), { GEMINI_API_KEY: 'test-key' }, {});
  assert.equal(successResponse.status, 200);
  assert.deepEqual(await successResponse.json(), {
    images: [
      'https://upload.wikimedia.org/heart-one.jpg',
      'https://upload.wikimedia.org/heart-two.jpg'
    ]
  });
  assert.match(requestedUrls[1], /gsrsearch=human\+heart\+anatomy/);
  assert.match(requestedUrls[1], /gsrlimit=5/);

  globalThis.fetch = async () => new Response('failed', { status: 500 });
  const failureResponse = await worker.fetch(request({ query: 'lungs' }), { GEMINI_API_KEY: 'test-key' }, {});
  assert.equal(failureResponse.status, 502);
  assert.deepEqual(await failureResponse.json(), { error: 'Something went wrong' });

  console.log('Media search routing validation passed.');
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

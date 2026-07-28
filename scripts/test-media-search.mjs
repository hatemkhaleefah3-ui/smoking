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
    assertCommonsRequest(url, options);
    return commonsResponse('heart-one.jpg', 'heart-two.jpg');
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

  // A missing key must not break image search. The endpoint should call
  // Wikimedia directly with the visitor's original query.
  const missingKeyUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    missingKeyUrls.push(String(url));
    assert.doesNotMatch(String(url), /generativelanguage\.googleapis\.com/);
    assertCommonsRequest(url, options);
    return commonsResponse('heart-fallback.jpg');
  };
  const missingKeyResponse = await worker.fetch(request({ query: 'Heart' }), {}, {});
  assert.equal(missingKeyResponse.status, 200);
  assert.deepEqual(await missingKeyResponse.json(), {
    images: ['https://upload.wikimedia.org/heart-fallback.jpg']
  });
  assert.match(missingKeyUrls[0], /gsrsearch=Heart/);

  // Invalid, restricted, or unavailable Gemini access should also fall back to
  // Wikimedia rather than returning a generic frontend failure.
  let fallbackCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    fallbackCalls += 1;
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response('forbidden', { status: 403 });
    }
    assertCommonsRequest(url, options);
    return commonsResponse('lungs-fallback.jpg');
  };
  const geminiFailureResponse = await worker.fetch(request({ query: 'lungs' }), { GEMINI_API_KEY: 'invalid-key' }, {});
  assert.equal(geminiFailureResponse.status, 200);
  assert.equal(fallbackCalls, 2);
  assert.deepEqual(await geminiFailureResponse.json(), {
    images: ['https://upload.wikimedia.org/lungs-fallback.jpg']
  });

  // Wikimedia can report an API-level error with HTTP 200. Treat that as an
  // upstream failure instead of silently returning an empty result set.
  globalThis.fetch = async (url, options = {}) => {
    assertCommonsRequest(url, options);
    return Response.json({ error: { code: 'baduseragent', info: 'Client identification required.' } });
  };
  const wikimediaApiErrorResponse = await worker.fetch(request({ query: 'heart' }), {}, {});
  assert.equal(wikimediaApiErrorResponse.status, 502);
  assert.deepEqual(await wikimediaApiErrorResponse.json(), { error: 'Something went wrong' });

  globalThis.fetch = async () => new Response('failed', { status: 500 });
  const wikimediaFailureResponse = await worker.fetch(request({ query: 'lungs' }), {}, {});
  assert.equal(wikimediaFailureResponse.status, 502);
  assert.deepEqual(await wikimediaFailureResponse.json(), { error: 'Something went wrong' });

  console.log('Media search routing, fallback and Wikimedia identification validation passed.');
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

function assertCommonsRequest(url, options) {
  assert.match(String(url), /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
  assert.doesNotMatch(String(url), /(?:^|[?&])origin=/);
  assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.1 \(https:\/\/github\.com\/hatemkhaleefah3-ui\/smoking\)$/);
  assert.equal(options.headers['Api-User-Agent'], options.headers['User-Agent']);
}

function commonsResponse(...filenames) {
  return Response.json({
    query: {
      pages: Object.fromEntries(filenames.map((filename, index) => [
        index + 1,
        { imageinfo: [{ url: `https://upload.wikimedia.org/${filename}` }] }
      ]))
    }
  });
}

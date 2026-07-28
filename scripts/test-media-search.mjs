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
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.equal(body.generationConfig.responseSchema.properties.searchTerm.type, 'STRING');
      assert.match(body.contents[0].parts[0].text, /Heart -> human heart anatomy diagram medical illustration/);
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ searchTerm: 'human heart anatomy diagram medical illustration' }) }] } }]
      });
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
      'https://upload.wikimedia.org/thumb/heart-one.jpg/900px-heart-one.jpg',
      'https://upload.wikimedia.org/thumb/heart-two.jpg/900px-heart-two.jpg'
    ]
  });
  assert.match(requestedUrls[1], /gsrsearch=human\+heart\+anatomy\+diagram\+medical\+illustration/);
  assert.match(requestedUrls[1], /gsrlimit=10/);

  // A missing key must still expand an ambiguous anatomy term instead of sending
  // the raw word "Heart" to Commons, where it can match songs and sheet music.
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
    images: ['https://upload.wikimedia.org/thumb/heart-fallback.jpg/900px-heart-fallback.jpg']
  });
  assert.match(missingKeyUrls[0], /gsrsearch=human\+heart\+anatomy\+diagram\+medical\+illustration/);
  assert.doesNotMatch(missingKeyUrls[0], /gsrsearch=Heart(?:&|$)/);

  // Explicit non-medical intent must not be rewritten as anatomy.
  let symbolUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    symbolUrl = String(url);
    assertCommonsRequest(url, options);
    return commonsResponse('heart-symbol.svg');
  };
  const symbolResponse = await worker.fetch(request({ query: 'heart symbol' }), {}, {});
  assert.equal(symbolResponse.status, 200);
  assert.match(symbolUrl, /gsrsearch=heart\+symbol/);
  assert.doesNotMatch(symbolUrl, /anatomy/);

  // Even if Gemini returns an overly broad medical term, the server must enforce
  // anatomy and visual context before calling Commons.
  let broadGeminiCommonsUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ searchTerm: 'heart' }) }] } }]
      });
    }
    broadGeminiCommonsUrl = String(url);
    assertCommonsRequest(url, options);
    return commonsResponse('heart-enforced.jpg');
  };
  const broadGeminiResponse = await worker.fetch(request({ query: 'Heart' }), { GEMINI_API_KEY: 'test-key' }, {});
  assert.equal(broadGeminiResponse.status, 200);
  assert.match(broadGeminiCommonsUrl, /gsrsearch=human\+heart\+anatomy\+diagram\+medical\+illustration/);

  // Invalid, restricted, or unavailable Gemini access should use the same
  // deterministic anatomy refinement instead of the ambiguous raw query.
  let fallbackCalls = 0;
  let fallbackCommonsUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    fallbackCalls += 1;
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response('forbidden', { status: 403 });
    }
    fallbackCommonsUrl = String(url);
    assertCommonsRequest(url, options);
    return commonsResponse('lungs-fallback.jpg');
  };
  const geminiFailureResponse = await worker.fetch(request({ query: 'lungs' }), { GEMINI_API_KEY: 'invalid-key' }, {});
  assert.equal(geminiFailureResponse.status, 200);
  assert.equal(fallbackCalls, 2);
  assert.match(fallbackCommonsUrl, /gsrsearch=human\+lungs\+anatomy\+diagram\+medical\+illustration/);
  assert.deepEqual(await geminiFailureResponse.json(), {
    images: ['https://upload.wikimedia.org/thumb/lungs-fallback.jpg/900px-lungs-fallback.jpg']
  });

  // Non-image Commons files are ignored, and display thumbnails are preferred to
  // original source URLs for reliable, bandwidth-conscious rendering.
  globalThis.fetch = async (url, options = {}) => {
    assertCommonsRequest(url, options);
    return Response.json({
      query: {
        pages: {
          1: { imageinfo: [{ mime: 'audio/ogg', url: 'https://upload.wikimedia.org/audio.ogg' }] },
          2: {
            imageinfo: [{
              mime: 'image/svg+xml',
              url: 'https://upload.wikimedia.org/diagram.svg',
              thumburl: 'https://upload.wikimedia.org/thumb/diagram.svg/900px-diagram.svg.png'
            }]
          }
        }
      }
    });
  };
  const filteringResponse = await worker.fetch(request({ query: 'heart' }), {}, {});
  assert.deepEqual(await filteringResponse.json(), {
    images: ['https://upload.wikimedia.org/thumb/diagram.svg/900px-diagram.svg.png']
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

  console.log('Media search relevance, fallback and Wikimedia validation passed.');
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
  const value = String(url);
  assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
  assert.doesNotMatch(value, /(?:^|[?&])origin=/);
  assert.match(value, /gsrnamespace=6/);
  assert.match(value, /iiprop=url%7Cmime/);
  assert.match(value, /iiurlwidth=900/);
  assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.2 \(https:\/\/github\.com\/hatemkhaleefah3-ui\/smoking\)$/);
  assert.equal(options.headers['Api-User-Agent'], options.headers['User-Agent']);
}

function commonsResponse(...filenames) {
  return Response.json({
    query: {
      pages: Object.fromEntries(filenames.map((filename, index) => [
        index + 1,
        {
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

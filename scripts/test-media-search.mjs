import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch should not run'); };
  const emptyResponse = await worker.fetch(request({ query: '   ' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(emptyResponse.status, 400);
  assert.equal(fetchCalls, 0);

  // Glycolysis: use no more than two qualifiers, omit the domain from the final
  // Commons query, and broaden automatically when the precise query is empty.
  const glycolysisUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      const schema = body.generationConfig.responseSchema;
      assert.equal(schema.properties.qualifiers.maxItems, 2);
      assert.match(prompt, /at most two short precision qualifiers/i);
      assert.match(prompt, /Prefer one qualifier/i);
      assert.doesNotMatch(prompt, /up to four/i);
      return geminiPlan({
        canonicalTopic: 'glycolysis',
        domain: 'biochemistry',
        visualType: 'biochemical pathway diagram',
        qualifiers: ['enzymes', 'ATP production', 'metabolic pathway', 'cytoplasm']
      });
    }

    glycolysisUrls.push(value);
    assertCommonsRequest(url, options);
    return glycolysisUrls.length === 1
      ? commonsResponse()
      : commonsResponse('glycolysis-one.svg', 'glycolysis-two.png', 'glycolysis-three.jpg', 'glycolysis-four.svg');
  };

  const glycolysisResponse = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(glycolysisResponse.status, 200);
  assert.equal(glycolysisUrls.length, 2);
  assert.match(glycolysisUrls[0], /gsrsearch=glycolysis\+biochemical\+pathway\+diagram\+enzymes\+ATP\+production/);
  assert.doesNotMatch(glycolysisUrls[0], /biochemistry/);
  assert.doesNotMatch(glycolysisUrls[0], /metabolic\+pathway|cytoplasm/);
  assert.match(glycolysisUrls[1], /gsrsearch=glycolysis\+biochemical\+pathway\+diagram/);
  assert.doesNotMatch(glycolysisUrls[1], /enzymes|ATP\+production/);
  assert.equal((await glycolysisResponse.json()).images.length, 4);

  // Heart: one precise result should trigger a broader topic + visual-type query,
  // and duplicate URLs must be merged into a larger unique result set.
  const heartUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('generativelanguage.googleapis.com')) {
      return geminiPlan({
        canonicalTopic: 'human heart',
        domain: 'anatomy',
        visualType: 'labeled anatomical diagram',
        qualifiers: ['chambers']
      });
    }

    heartUrls.push(value);
    assertCommonsRequest(url, options);
    return heartUrls.length === 1
      ? commonsResponse('heart-one.svg')
      : commonsResponse('heart-one.svg', 'heart-two.svg', 'heart-three.jpg', 'heart-four.png');
  };

  const heartResponse = await worker.fetch(request({ query: 'Heart' }), { GEMINI_API_KEY: 'test-key' });
  const heartResult = await heartResponse.json();
  assert.equal(heartResponse.status, 200);
  assert.equal(heartUrls.length, 2);
  assert.match(heartUrls[0], /human\+heart\+labeled\+anatomical\+diagram\+chambers/);
  assert.match(heartUrls[1], /human\+heart\+labeled\+anatomical\+diagram/);
  assert.doesNotMatch(heartUrls[1], /chambers/);
  assert.equal(heartResult.images.length, 4);
  assert.equal(new Set(heartResult.images).size, 4);

  // Three precise results are sufficient; no broader second request is needed.
  let histologyCommonsCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return geminiPlan({
        canonicalTopic: 'renal glomerulus',
        domain: 'histology',
        visualType: 'histology micrograph',
        qualifiers: ['kidney cortex']
      });
    }
    histologyCommonsCalls += 1;
    assertCommonsRequest(url, options);
    return commonsResponse('glomerulus-one.jpg', 'glomerulus-two.jpg', 'glomerulus-three.jpg');
  };
  const histologyResponse = await worker.fetch(request({ query: 'glomerulus' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(histologyResponse.status, 200);
  assert.equal(histologyCommonsCalls, 1);

  // Missing Gemini access also uses concise primary and broad fallback queries.
  const fallbackUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    fallbackUrls.push(String(url));
    assert.doesNotMatch(String(url), /generativelanguage\.googleapis\.com/);
    assertCommonsRequest(url, options);
    return fallbackUrls.length === 1 ? commonsResponse() : commonsResponse('fallback-one.jpg', 'fallback-two.jpg');
  };
  const missingKeyResponse = await worker.fetch(request({ query: 'Glycolysis' }), {});
  assert.equal(missingKeyResponse.status, 200);
  assert.match(fallbackUrls[0], /gsrsearch=Glycolysis\+scientific\+diagram/);
  assert.match(fallbackUrls[1], /gsrsearch=Glycolysis\+diagram/);

  // Invalid structured output falls back to the same concise two-stage search.
  const invalidPlanUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return geminiPlan({ canonicalTopic: 'glycolysis', domain: '', visualType: 'butterfly', qualifiers: [] });
    }
    invalidPlanUrls.push(String(url));
    assertCommonsRequest(url, options);
    return invalidPlanUrls.length === 1 ? commonsResponse() : commonsResponse('fallback-three.jpg');
  };
  const invalidPlanResponse = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(invalidPlanResponse.status, 200);
  assert.match(invalidPlanUrls[0], /Glycolysis\+scientific\+diagram/);
  assert.match(invalidPlanUrls[1], /Glycolysis\+diagram/);

  // Non-image files are ignored and display thumbnails are preferred.
  globalThis.fetch = async (url, options = {}) => {
    assertCommonsRequest(url, options);
    return Response.json({
      query: {
        pages: {
          1: { imageinfo: [{ mime: 'audio/ogg', url: 'https://upload.wikimedia.org/audio.ogg' }] },
          2: {
            imageinfo: [{
              mime: 'image/svg+xml',
              url: 'https://upload.wikimedia.org/pathway.svg',
              thumburl: 'https://upload.wikimedia.org/thumb/pathway.svg/900px-pathway.svg.png'
            }]
          }
        }
      }
    });
  };
  const filteringResponse = await worker.fetch(request({ query: 'glycolysis' }), {});
  assert.deepEqual(await filteringResponse.json(), {
    images: ['https://upload.wikimedia.org/thumb/pathway.svg/900px-pathway.svg.png']
  });

  globalThis.fetch = async (url, options = {}) => {
    assertCommonsRequest(url, options);
    return Response.json({ error: { code: 'baduseragent', info: 'Client identification required.' } });
  };
  const wikimediaApiErrorResponse = await worker.fetch(request({ query: 'glycolysis' }), {});
  assert.equal(wikimediaApiErrorResponse.status, 502);
  assert.deepEqual(await wikimediaApiErrorResponse.json(), { error: 'Something went wrong' });

  console.log('Concise scientific media query validation passed.');
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

function geminiPlan(plan) {
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }]
  });
}

function assertCommonsRequest(url, options) {
  const value = String(url);
  assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
  assert.match(value, /gsrlimit=15/);
  assert.match(value, /gsrnamespace=6/);
  assert.match(value, /iiprop=url%7Cmime/);
  assert.match(value, /iiurlwidth=900/);
  assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.4 \(https:\/\/github\.com\/hatemkhaleefah3-ui\/smoking\)$/);
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

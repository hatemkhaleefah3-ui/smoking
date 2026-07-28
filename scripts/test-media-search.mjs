import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('fetch should not run'); };
  const emptyResponse = await worker.fetch(request({ query: '   ' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(emptyResponse.status, 400);
  assert.equal(fetchCalls, 0);

  const requestedUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    requestedUrls.push(String(url));
    if (String(url).includes('generativelanguage.googleapis.com')) {
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      const schema = body.generationConfig.responseSchema;
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(schema.required, ['canonicalTopic', 'domain', 'visualType', 'qualifiers']);
      assert.ok(schema.properties.visualType.enum.includes('biochemical pathway diagram'));
      assert.ok(schema.properties.visualType.enum.includes('histology micrograph'));
      assert.ok(schema.properties.visualType.enum.includes('technical schematic'));
      assert.match(prompt, /metabolism, signaling, or enzyme sequences -> biochemical pathway diagram/);
      assert.match(prompt, /tissue architecture or pathology -> histology micrograph/);
      assert.match(prompt, /machines, circuits, devices, or engineering systems/);
      assert.doesNotMatch(prompt, /Heart ->/);
      return geminiPlan({
        canonicalTopic: 'glycolysis',
        domain: 'biochemistry',
        visualType: 'biochemical pathway diagram',
        qualifiers: ['enzymes', 'ATP production', 'metabolic pathway']
      });
    }
    assertCommonsRequest(url, options);
    return commonsResponse('glycolysis-one.svg', 'glycolysis-two.png');
  };

  const glycolysisResponse = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(glycolysisResponse.status, 200);
  assert.deepEqual(await glycolysisResponse.json(), {
    images: [
      'https://upload.wikimedia.org/thumb/glycolysis-one.svg/900px-glycolysis-one.svg',
      'https://upload.wikimedia.org/thumb/glycolysis-two.png/900px-glycolysis-two.png'
    ]
  });
  assert.match(requestedUrls[1], /gsrsearch=glycolysis\+biochemistry/);
  assert.match(requestedUrls[1], /biochemical\+pathway\+diagram/);
  assert.match(requestedUrls[1], /ATP\+production/);
  assert.doesNotMatch(requestedUrls[1], /gsrsearch=Glycolysis(?:&|$)/);

  // The same generic prompt must select a histology visual without keyword-specific server rules.
  let histologyUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return geminiPlan({
        canonicalTopic: 'renal glomerulus',
        domain: 'histology',
        visualType: 'histology micrograph',
        qualifiers: ['kidney cortex', 'labeled']
      });
    }
    histologyUrl = String(url);
    assertCommonsRequest(url, options);
    return commonsResponse('glomerulus.jpg');
  };
  const histologyResponse = await worker.fetch(request({ query: 'glomerulus' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(histologyResponse.status, 200);
  assert.match(histologyUrl, /renal\+glomerulus\+histology\+histology\+micrograph/);
  assert.match(histologyUrl, /kidney\+cortex/);

  // Technical topics are expanded through the same schema and prompt.
  let technicalUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return geminiPlan({
        canonicalTopic: 'central processing unit architecture',
        domain: 'computer engineering',
        visualType: 'block diagram',
        qualifiers: ['control unit', 'arithmetic logic unit']
      });
    }
    technicalUrl = String(url);
    assertCommonsRequest(url, options);
    return commonsResponse('cpu.svg');
  };
  const technicalResponse = await worker.fetch(request({ query: 'CPU' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(technicalResponse.status, 200);
  assert.match(technicalUrl, /central\+processing\+unit\+architecture/);
  assert.match(technicalUrl, /computer\+engineering\+block\+diagram/);

  // Missing Gemini access uses one generic academic expansion, never a hardcoded topic exception.
  let missingKeyUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    missingKeyUrl = String(url);
    assert.doesNotMatch(missingKeyUrl, /generativelanguage\.googleapis\.com/);
    assertCommonsRequest(url, options);
    return commonsResponse('fallback.jpg');
  };
  const missingKeyResponse = await worker.fetch(request({ query: 'Glycolysis' }), {});
  assert.equal(missingKeyResponse.status, 200);
  assert.match(missingKeyUrl, /gsrsearch=Glycolysis\+educational\+scientific\+technical\+diagram\+illustration/);

  // Invalid or incomplete structured output also falls back generically.
  let invalidPlanCommonsUrl = '';
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return geminiPlan({ canonicalTopic: 'glycolysis', domain: '', visualType: 'butterfly', qualifiers: [] });
    }
    invalidPlanCommonsUrl = String(url);
    assertCommonsRequest(url, options);
    return commonsResponse('fallback-two.jpg');
  };
  const invalidPlanResponse = await worker.fetch(request({ query: 'Glycolysis' }), { GEMINI_API_KEY: 'test-key' });
  assert.equal(invalidPlanResponse.status, 200);
  assert.match(invalidPlanCommonsUrl, /Glycolysis\+educational\+scientific\+technical\+diagram\+illustration/);

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

  console.log('Generic scientific media refinement validation passed.');
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
  assert.match(value, /gsrnamespace=6/);
  assert.match(value, /iiprop=url%7Cmime/);
  assert.match(value, /iiurlwidth=900/);
  assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.3 \(https:\/\/github\.com\/hatemkhaleefah3-ui\/smoking\)$/);
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

import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  const originalQuery = 'Diagram showing phenylalanine blocked from producing tyrosinase-dependent melanin due to tyrosinase deficiency, halting conversion of tyrosine to DOPA.';
  const searchedTerms = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
    assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.6 /);

    const term = new URL(value).searchParams.get('gsrsearch') || '';
    searchedTerms.push(term);

    if (searchedTerms.length === 1) {
      return Response.json({ query: { pages: {} } });
    }

    return commonsResponse(`${term}.svg`);
  };

  const response = await worker.fetch(request({ query: originalQuery }), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.images.length >= 1, 'A long medical alt text should produce fallback Commons results.');
  assert.ok(searchedTerms.length >= 2, 'The enhanced handler should retry an empty literal search.');
  assert.ok(
    searchedTerms.slice(1).every((term) => term.length < originalQuery.length),
    'Fallback terms should be shorter than the original descriptive sentence.'
  );
  assert.ok(
    searchedTerms.slice(1).some((term) => /tyrosinase|melanin|phenylalanine|tyrosine|dopa/i.test(term)),
    'Fallback terms should retain the scientific subject.'
  );

  console.log('Enhanced descriptive media-search fallback validation passed.');
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

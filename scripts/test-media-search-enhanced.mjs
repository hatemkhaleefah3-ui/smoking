import assert from 'node:assert/strict';
import worker from '../worker/src/pages.js';

const originalFetch = globalThis.fetch;

try {
  const originalQuery = 'Diagram showing phenylalanine blocked from producing tyrosinase-dependent melanin due to tyrosinase deficiency, halting conversion of tyrosine to DOPA.';
  const searchedTerms = [];

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    assert.match(value, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?/);
    assert.match(options.headers['User-Agent'], /^LecturePublisherMediaSearch\/1\.[67] /);

    const term = new URL(value).searchParams.get('gsrsearch') || '';
    searchedTerms.push(term);

    if (term === originalQuery) {
      return Response.json({ query: { pages: {} } });
    }

    return commonsResponse(
      'Unrelated landscape photograph.jpg',
      `${term} pathway diagram.svg`,
      `${term} medical illustration.png`,
      `${term} biochemical reaction.jpg`,
      `${term} educational figure.svg`,
      `${term} clinical overview.png`,
      `${term} metabolism chart.jpg`,
      `${term} scientific scheme.svg`
    );
  };

  const response = await worker.fetch(request({ query: originalQuery }), {});
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.ok(payload.images.length >= 10, 'A descriptive medical query should fill a useful carousel, not stop at one image.');
  assert.ok(searchedTerms.length >= 3, 'The enhanced handler should gather results from multiple concise searches.');
  assert.ok(
    searchedTerms.slice(1).every((term) => term.length < originalQuery.length),
    'Fallback terms should be shorter than the original descriptive sentence.'
  );
  assert.ok(
    searchedTerms.slice(1).some((term) => !term.includes(' ')),
    'Broad fallback should include a strong single scientific term.'
  );
  assert.ok(
    searchedTerms.slice(1).some((term) => /tyrosinase|melanin|phenylalanine|tyrosine|dopa/i.test(term)),
    'Fallback terms should retain the scientific subject.'
  );
  assert.doesNotMatch(
    decodeURIComponent(payload.images[0]),
    /Unrelated landscape/i,
    'A strong scientific title match should rank before an unrelated Commons result.'
  );
  assert.ok(
    payload.images.some((url) => /Unrelated%20landscape|Unrelated landscape/i.test(url)),
    'Near-match fallback should remain broad instead of discarding every lower-ranked result.'
  );

  console.log('Broader descriptive media-search ranking validation passed.');
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
            mime: title.endsWith('.svg') ? 'image/svg+xml' : title.endsWith('.png') ? 'image/png' : 'image/jpeg',
            url: `https://upload.wikimedia.org/${encodeURIComponent(title)}`,
            thumburl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title)}/900px-${encodeURIComponent(title)}`
          }]
        }
      ]))
    }
  });
}
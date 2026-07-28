import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../image-candidate-carousel.js', import.meta.url), 'utf8');

assert.match(
  source,
  /new MutationObserver\(\(\) => queueRender\(true\)\)/,
  'Image-card insertion must request pending Wikimedia searches.'
);
assert.match(
  source,
  /if \(startSearch\) state\.startSearchQueued = true;/,
  'A search-start request must be preserved while a render is already queued.'
);
assert.match(
  source,
  /const shouldStartSearch = state\.startSearchQueued;[\s\S]*render\(shouldStartSearch\);/,
  'The queued search-start flag must be consumed by the next render.'
);
assert.doesNotMatch(
  source,
  /new MutationObserver\(\(\) => queueRender\(false\)\)/,
  'The image-card observer must not render without starting unsearched carousels.'
);

console.log('Wikimedia carousel startup regression validation passed.');

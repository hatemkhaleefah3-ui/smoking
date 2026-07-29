import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleRelevantIntentMediaSearch } from '../worker/src/media-search-relevance.js';

const source = await readFile(new URL('../worker/src/media-search-relevance.js', import.meta.url), 'utf8');
const pages = await readFile(new URL('../worker/src/pages.js', import.meta.url), 'utf8');
const patch = await readFile(new URL('./intent-carousel-patch.mjs', import.meta.url), 'utf8');

assert.equal(typeof handleRelevantIntentMediaSearch, 'function');
assert.match(source, /STRICT_RELEVANCE_SCORE = 65/);
assert.match(source, /if \(ranked\.relevant\.length === 0\)/);
assert.match(source, /It is better to return no image than a misleading image/);
assert.match(source, /strict semantic filtering found no relevant image/);
assert.match(source, /candidate\.geminiUsefulness >= STRICT_RELEVANCE_SCORE/);
assert.match(source, /candidate\.hasCoreMatch && candidate\.localScore >= LOCAL_RELEVANCE_SCORE/);
assert.match(pages, /handleRelevantIntentMediaSearch/);
assert.match(patch, /strictRelevance: true/);

const delegated = await handleRelevantIntentMediaSearch(new Request('https://example.com/api/search'), {});
assert.equal(delegated, null, 'Non-POST requests should preserve the existing intent handler behavior.');

console.log('Strict Wikimedia relevance filtering validation passed.');
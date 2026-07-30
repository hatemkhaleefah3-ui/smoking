import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const index = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8');

const jsMatch = index.match(/src="(image-candidate-carousel\.([a-f0-9]{12})\.js)"/);
const cssMatch = index.match(/href="(image-candidate-carousel\.([a-f0-9]{12})\.css)"/);
assert.ok(jsMatch, 'The built page must reference a content-hashed carousel JavaScript file.');
assert.ok(cssMatch, 'The built page must reference a content-hashed carousel stylesheet.');
assert.equal(jsMatch[2], cssMatch[2], 'The carousel JavaScript and CSS must share one build identifier.');
assert.match(index, new RegExp(`data-media-search-build="${jsMatch[2]}"`));
assert.match(index, /<meta name="media-search-runtime" content="[^"]+">/);
assert.doesNotMatch(index, /src="image-candidate-carousel\.js"/);
assert.doesNotMatch(index, /href="image-candidate-carousel\.css"/);

await access(new URL(`../dist/${jsMatch[1]}`, import.meta.url));
await access(new URL(`../dist/${cssMatch[1]}`, import.meta.url));
assert.match(headers, /\/index\.html[\s\S]*Cache-Control: no-store/);
assert.match(headers, /image-candidate-carousel\.\*\.js[\s\S]*immutable/);
assert.match(headers, /image-candidate-carousel\.\*\.css[\s\S]*immutable/);

console.log(`Media search build ${jsMatch[2]} is cache-busted and marked in the document.`);

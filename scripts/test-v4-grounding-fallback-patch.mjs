import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { generateV4RuntimeEngine } from './generate-v4-runtime-engine.mjs';
import { patchV4GroundingFallback } from './patch-v4-grounding-fallback.mjs';

await generateV4RuntimeEngine();
const outputPath = await patchV4GroundingFallback();
const source = await readFile(outputPath, 'utf8');

assert.match(source, /Google Search grounding is unavailable for this request/);
assert.match(source, /googleSearch: true/);
assert.match(source, /googleSearch: false/);
assert.match(source, /groundingFallback: true/);
assert.match(source, /groundingFailure/);
assert.match(source, /groundingFallback: groundedResponse\?\.groundingFallback === true/);
assert.match(source, /LecturePublisherMultiSourceSearch\/4\.3/);
assert.match(source, /multi-source-v4-runtime/);
assert.match(source, /No fallback images were returned/);

const syntax = spawnSync(process.execPath, ['--check', resolve(outputPath)], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

console.log('V4 non-grounded visual-brief fallback validation passed.');

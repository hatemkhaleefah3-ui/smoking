import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { generateV4RuntimeEngine } from './generate-v4-runtime-engine.mjs';
import { patchV4GroundingFallback } from './patch-v4-grounding-fallback.mjs';
import { patchV4ModelApiCompatibility } from './patch-v4-model-api-compatibility.mjs';

await generateV4RuntimeEngine();
await patchV4GroundingFallback();
const outputPath = await patchV4ModelApiCompatibility();
const source = await readFile(outputPath, 'utf8');

assert.match(source, /gemini-2\.5-flash-lite/);
assert.match(source, /gemini-2\.5-flash/);
assert.doesNotMatch(source, /generationConfig\.responseFormat/);
assert.match(source, /generationConfig\.responseMimeType = 'application\/json'/);
assert.match(source, /generationConfig\.responseSchema = legacySchema/);
assert.match(source, /key === 'additionalProperties' \? undefined : value/);
assert.match(source, /formatRejected/);
assert.match(source, /response\.status === 429/);
assert.match(source, /Google Search grounding is unavailable for this request/);
assert.match(source, /groundingFallback: true/);

const syntax = spawnSync(process.execPath, ['--check', resolve(outputPath)], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

console.log('V4 sanitized legacy generateContent schema validation passed.');

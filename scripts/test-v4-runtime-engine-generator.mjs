import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { generateV4RuntimeEngine } from './generate-v4-runtime-engine.mjs';

const outputPath = await generateV4RuntimeEngine();
const source = await readFile(outputPath, 'utf8');

assert.match(source, /handleMultiSourceMediaSearchV4Runtime/);
assert.match(source, /engine: 'multi-source-v4-runtime'/);
assert.match(source, /const generationConfig = googleSearch\s*\? \{ maxOutputTokens \}/);
assert.match(source, /Required JSON schema:/);
assert.match(source, /Do not include Markdown fences or explanatory text/);
assert.match(source, /responseFormat: \{ text: \{ mimeType: 'application\/json', schema \} \}/);
assert.match(source, /gemini-3\.5-flash-lite/);
assert.match(source, /gemini-3\.1-flash-lite/);
assert.match(source, /response\.status === 429 \|\| response\.status >= 500/);
assert.match(source, /await delay\(250 \* \(2 \*\* index\)\)/);
assert.match(source, /Gemini models unavailable/);
assert.match(source, /geminiModelsUsed: \[\.\.\.geminiModelsUsed\]/);
assert.match(source, /quotaExhausted/);
assert.match(source, /No fallback images were returned/);
assert.match(source, /responseText\.slice\(start, end \+ 1\)/);

const syntax = spawnSync(process.execPath, ['--check', resolve(outputPath)], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

console.log('Quota-resilient V4 engine generation validation passed.');

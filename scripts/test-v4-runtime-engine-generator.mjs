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
assert.match(source, /const detail = await response\.text\(\)\.catch/);
assert.match(source, /responseText\.slice\(start, end \+ 1\)/);
assert.match(source, /input\?\.diagnosticMode === true/);
assert.match(source, /diagnosticFailure: true/);

const syntax = spawnSync(process.execPath, ['--check', resolve(outputPath)], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

console.log('Live-compatible V4 engine generation validation passed.');

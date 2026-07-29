import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateDiverseMediaEngine } from './generate-diverse-media-engine.mjs';

const path = await generateDiverseMediaEngine();
const source = await readFile(path, 'utf8');

assert.match(source, /handleMultiSourceMediaSearchV3/);
assert.match(source, /engine: 'multi-source-v3'/);
assert.match(source, /searchRun < 1 && excludedUrls\.size === 0/);
assert.match(source, /gsroffset: String\(\(Math\.max\(1, page\) - 1\) \* RESULTS_PER_SOURCE\)/);
assert.match(source, /page: String\(Math\.max\(1, page\)\)/);
assert.match(source, /rotatedSourceOrder\(cycle, searchRun\)/);
assert.match(source, /isExcludedCandidate\(candidate, excludedUrls\)/);
assert.match(source, /alternative search run/);

const syntax = spawnSync(process.execPath, ['--check', resolve(path)], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

console.log('Distinct-result multi-source V3 generation validation passed.');

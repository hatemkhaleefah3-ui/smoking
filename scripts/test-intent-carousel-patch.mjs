import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchIntentCarousel } from './intent-carousel-patch.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'intent-carousel-'));
const target = resolve(directory, 'image-candidate-carousel.js');

try {
  await cp(new URL('../image-candidate-carousel.js', import.meta.url), target);
  await patchIntentCarousel(directory);
  const source = await readFile(target, 'utf8');

  assert.match(source, /intentSearch:\s*true/);
  assert.match(source, /strictRelevance:\s*true/);
  assert.match(source, /altTexts:\s*definition\.altTexts/);
  assert.match(source, /label:\s*definition\.label/);
  assert.match(source, /Gemini is understanding and searching/);
  assert.match(source, /cardState\.usefulCount/);
  assert.match(source, /state\.activeSearches < 2/);
  assert.match(source, /enqueueSearch\(definition\)/);
  assert.match(source, /Waiting for Gemini search/);
  assert.doesNotMatch(source, /for \(const altText of definition\.altTexts\)/);

  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  console.log('Strict, combined and queued carousel payload validation passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
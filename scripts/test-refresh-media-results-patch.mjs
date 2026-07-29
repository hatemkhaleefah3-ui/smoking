import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchIntentCarousel } from './intent-carousel-patch.mjs';
import { patchProviderObservability } from './provider-observability-patch.mjs';
import { patchRefreshMediaResults } from './refresh-media-results-patch.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'refresh-media-results-'));
const target = resolve(directory, 'image-candidate-carousel.js');

try {
  await cp(new URL('../image-candidate-carousel.js', import.meta.url), target);
  await patchIntentCarousel(directory);
  await patchProviderObservability(directory);
  await patchRefreshMediaResults(directory);
  const source = await readFile(target, 'utf8');

  assert.match(source, /prepareAllCardsForFreshSearch\(\)/);
  assert.match(source, /Refresh choices/);
  assert.match(source, /searchRun: cardState\.searchRun/);
  assert.match(source, /excludedUrls: cardState\.excludedUrls\.slice\(-120\)/);
  assert.match(source, /cardState\.candidates = cardState\.candidates\.filter\(\(candidate\) => !candidate\.remoteUrl\)/);
  assert.match(source, /Multi-source v4/);
  assert.match(source, /Multi-source v3/);
  assert.match(source, /enqueueSearch\(definition\)/);

  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  console.log('Fresh carousel result search validation passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}

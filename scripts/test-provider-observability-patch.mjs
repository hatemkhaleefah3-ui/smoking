import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchIntentCarousel } from './intent-carousel-patch.mjs';
import { patchProviderObservability } from './provider-observability-patch.mjs';

const directory = await mkdtemp(resolve(tmpdir(), 'provider-observability-'));
const target = resolve(directory, 'image-candidate-carousel.js');

try {
  await cp(new URL('../image-candidate-carousel.js', import.meta.url), target);
  await patchIntentCarousel(directory);
  await patchProviderObservability(directory);
  const source = await readFile(target, 'utf8');

  assert.match(source, /Multi-source/);
  assert.match(source, /Wikimedia-only fallback/);
  assert.match(source, /formatProviderSummary/);
  assert.match(source, /result\.providerDiagnostics/);
  assert.match(source, /result\.sourceCounts/);
  assert.match(source, /rawFound/);
  assert.match(source, /eligibleFound/);
  assert.match(source, /reviewed/);
  assert.match(source, /status\.title = cardState\.providerDetails/);

  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  console.log('Visible multi-source provider diagnostics validation passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}

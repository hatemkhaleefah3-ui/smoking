import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ASSETS = {
  adapter: {
    parts: 'embedded/integrated-pathways/adapter',
    output: 'integrated-v2-adapter.js',
    sha256: '4a50e4f3303d7609d422d4e75c11e80c5827fd3b4fb5c8e0ec74aba9d584d59e'
  },
  template: {
    parts: 'embedded/integrated-pathways/template',
    output: 'templates/lecture-template-integrated.html',
    sha256: 'a4632aa010d28c0db42abc813de30a2580dd3311a2fe97d2ead58b9042b8c5a4'
  },
  example: {
    parts: 'embedded/integrated-pathways/example',
    output: 'examples/lecture-system-v2.example.json',
    sha256: '8b6688959416d40d948dc1ec59bd3610eafb586654d14c3827996d711b764f8e'
  }
};

export async function readIntegratedAssets(root) {
  const entries = await Promise.all(Object.entries(ASSETS).map(async ([name, config]) => {
    const value = await decodeParts(resolve(root, config.parts));
    const digest = createHash('sha256').update(value).digest('hex');
    if (digest !== config.sha256) {
      throw new Error(`Integrated Pathways ${name} checksum mismatch: expected ${config.sha256}, received ${digest}.`);
    }
    return [name, value];
  }));
  return Object.fromEntries(entries);
}

export async function writeIntegratedAssets(root, dist) {
  const assets = await readIntegratedAssets(root);
  for (const [name, config] of Object.entries(ASSETS)) {
    const output = resolve(dist, config.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, assets[name], 'utf8');
  }
}

async function decodeParts(directory) {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith('.b64'))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!filenames.length) throw new Error(`No embedded asset parts found in ${directory}.`);
  const parts = await Promise.all(filenames.map((filename) => readFile(resolve(directory, filename), 'utf8')));
  const encoded = parts.join('').replace(/\s+/g, '');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

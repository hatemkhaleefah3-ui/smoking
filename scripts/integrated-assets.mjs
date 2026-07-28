import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ASSETS = {
  adapter: {
    parts: 'embedded/integrated-pathways/adapter',
    output: 'integrated-v2-adapter.js',
    sha256: 'd489b496449bfe1f8539c65441610205f7ce37db5d8318d47fa563fb7cd6dc1e'
  },
  template: {
    parts: 'embedded/integrated-pathways/template',
    output: 'templates/lecture-template-integrated.html',
    sha256: 'd5ea5c00563636abce0908db1074cead2ec0b3a16aa5805ae84ad8e2f1113adb'
  },
  example: {
    parts: 'embedded/integrated-pathways/example',
    output: 'examples/lecture-system-v2.example.json',
    sha256: '5c035a5bc8ebcba7780080a57c2033e45832943a4661dc7cb2c671341fd86308'
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

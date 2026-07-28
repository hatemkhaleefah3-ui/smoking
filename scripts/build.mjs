import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeIntegratedAssets } from './integrated-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const files = [
  'index.html', 'styles.css', 'app.js', 'lecture-renderer.js', 'clinical-v2-adapter.js',
  'smart-media-search.css', 'smart-media-search.js',
  'lecture.html', 'lecture.js', 'admin.html', 'admin.css', 'admin.js', '404.html'
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(dist, file));
await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'examples'), resolve(dist, 'examples'), { recursive: true });
await writeIntegratedAssets(root, dist);

// Pages Advanced Mode ignores /functions and deploys dist/_worker.js. Bundle the
// complete router and its dependencies into that one file so no sibling Worker
// modules can be omitted or treated as static assets during deployment.
await build({
  entryPoints: [resolve(root, 'worker/src/pages.js')],
  outfile: resolve(dist, '_worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  legalComments: 'none'
});

// Wrangler must not publish the Advanced Mode entrypoint as a static asset.
await writeFile(resolve(dist, '.assetsignore'), '_worker.js\n');

console.log(`Built static assets and bundled Advanced Mode Worker in ${dist}`);

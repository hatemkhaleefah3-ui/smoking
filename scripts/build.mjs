import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const files = [
  'index.html', 'styles.css', 'pdf-extractor.css', 'app.js', 'pdf-extractor.js', 'lecture-renderer.js',
  'lecture.html', 'lecture.js', 'admin.html', 'admin.css', 'admin.js', '404.html'
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(dist, file));
await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'examples'), resolve(dist, 'examples'), { recursive: true });

// Cloudflare Pages Advanced Mode runs the bundled Module Worker at dist/_worker.js.
// MuPDF's WASM binary is inlined so the Pages artifact is self-contained.
await build({
  entryPoints: [resolve(root, 'worker/src/entry.js')],
  outfile: resolve(dist, '_worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  loader: { '.wasm': 'binary' },
  conditions: ['worker', 'browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  external: ['node:module', 'module', 'node:fs', 'fs', 'node:path', 'path'],
  legalComments: 'inline',
  logLevel: 'info'
});

// A second Cloudflare Workers build is connected to the same repository. Wrangler
// must not publish the Pages server module as a public static asset.
await writeFile(resolve(dist, '.assetsignore'), '_worker.js\n');

console.log(`Built Pages assets and PDF extraction worker in ${dist}`);

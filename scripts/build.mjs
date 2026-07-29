import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeIntegratedAssets } from './integrated-assets.mjs';
import { patchIntentCarousel } from './intent-carousel-patch.mjs';
import { patchProviderObservability } from './provider-observability-patch.mjs';
import { patchRefreshMediaResults } from './refresh-media-results-patch.mjs';
import { versionMediaSearchAssets } from './version-media-search-assets.mjs';
import { generateDiverseMediaEngine } from './generate-diverse-media-engine.mjs';
import { generateV4RuntimeEngine } from './generate-v4-runtime-engine.mjs';
import './generate-deployment-metadata.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const files = [
  'index.html', 'styles.css', 'image-import.css', 'pdf-image-autofill.css', 'image-candidate-carousel.css', 'pdf-extractor.css',
  'app.js', 'image-import.js', 'pdf-image-autofill.js', 'image-candidate-carousel.js', 'pdf-extractor.js',
  'lecture-renderer.js', 'clinical-v2-adapter.js',
  'smart-media-search.css', 'smart-media-search.js',
  'lecture.html', 'lecture.js', 'admin.html', 'admin.css', 'admin.js', '404.html'
];

await generateDiverseMediaEngine();
await generateV4RuntimeEngine();
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(resolve(dist, 'vendor'), { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(dist, file));
await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'examples'), resolve(dist, 'examples'), { recursive: true });
await writeIntegratedAssets(root, dist);
await patchIntentCarousel(dist);
await patchProviderObservability(dist);
await patchRefreshMediaResults(dist);
await versionMediaSearchAssets(dist);
await cp(
  resolve(root, 'node_modules/mupdf/dist/mupdf-wasm.wasm'),
  resolve(dist, 'vendor/mupdf-wasm.wasm')
);

const browserNodeBuiltins = {
  name: 'browser-node-builtins',
  setup(context) {
    context.onResolve({ filter: /^(?:node:)?(?:module|fs|path)$/ }, (args) => ({
      path: args.path.replace(/^node:/, ''),
      namespace: 'browser-node-builtin'
    }));
    context.onLoad({ filter: /.*/, namespace: 'browser-node-builtin' }, ({ path }) => ({
      loader: 'js',
      contents: path === 'module'
        ? `export function createRequire() { return () => { throw new Error('Node require is unavailable in this browser runtime.'); }; }\nexport default { createRequire };`
        : `const unavailable = () => { throw new Error('Node ${path} is unavailable in this browser runtime.'); };\nexport const readFileSync = unavailable;\nexport const readFile = unavailable;\nexport const dirname = unavailable;\nexport const resolve = unavailable;\nexport const join = unavailable;\nexport const promises = {};\nexport default {};`
    }));
  }
};

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

await build({
  entryPoints: [resolve(root, 'browser/pdf-extractor-runtime.js')],
  outfile: resolve(dist, 'pdf-extractor-runtime.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  define: { process: 'undefined' },
  plugins: [browserNodeBuiltins],
  legalComments: 'inline',
  minify: true,
  sourcemap: false
});

await writeFile(resolve(dist, '.assetsignore'), '_worker.js\n');

console.log(`Built static assets, PDF runtime and Advanced Mode Worker in ${dist}`);

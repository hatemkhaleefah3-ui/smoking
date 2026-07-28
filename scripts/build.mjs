import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeIntegratedAssets } from './integrated-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const files = [
  'index.html', 'styles.css', 'image-import.css', 'pdf-image-autofill.css', 'pdf-extractor.css',
  'app.js', 'image-import.js', 'pdf-image-autofill.js', 'pdf-extractor.js',
  'lecture-renderer.js', 'clinical-v2-adapter.js',
  'smart-media-search.css', 'smart-media-search.js',
  'lecture.html', 'lecture.js', 'admin.html', 'admin.css', 'admin.js', '404.html'
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(resolve(dist, 'vendor'), { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(dist, file));
await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'examples'), resolve(dist, 'examples'), { recursive: true });
await writeIntegratedAssets(root, dist);
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

// PDF decoding runs locally in the visitor's browser. MuPDF's WASM stays a
// cacheable static asset rather than increasing the Cloudflare Worker bundle.
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

// Wrangler must not publish the Advanced Mode entrypoint as a static asset.
await writeFile(resolve(dist, '.assetsignore'), '_worker.js\n');

console.log(`Built static assets, PDF runtime and Advanced Mode Worker in ${dist}`);

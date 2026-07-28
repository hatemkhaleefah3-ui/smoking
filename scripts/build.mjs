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
await mkdir(resolve(dist, 'vendor'), { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(dist, file));
await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'examples'), resolve(dist, 'examples'), { recursive: true });
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

const browserBundleOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  define: { process: 'undefined' },
  plugins: [browserNodeBuiltins],
  legalComments: 'inline',
  logLevel: 'info'
};

// Cloudflare Pages Advanced Mode runs this small Module Worker. CPU-heavy PDF
// decoding happens in the browser and the Worker only stores the finished result.
await build({
  ...browserBundleOptions,
  entryPoints: [resolve(root, 'worker/src/entry.js')],
  outfile: resolve(dist, '_worker.js'),
  conditions: ['worker', 'browser', 'import', 'default']
});

// MuPDF and fflate run in the user's browser, outside Cloudflare Worker CPU and
// WebAssembly restrictions. The WASM binary remains a cacheable static asset.
await build({
  ...browserBundleOptions,
  entryPoints: [resolve(root, 'browser/pdf-extractor-runtime.js')],
  outfile: resolve(dist, 'pdf-extractor-runtime.js'),
  minify: true
});

// A second Cloudflare Workers build is connected to the same repository. Wrangler
// must not publish the Pages server module as a public static asset.
await writeFile(resolve(dist, '.assetsignore'), '_worker.js\n');

console.log(`Built Pages assets, browser PDF runtime, and storage worker in ${dist}`);

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const files = [
  'index.html', 'styles.css', 'app.js', 'lecture-renderer.js',
  'lecture.html', 'lecture.js', 'admin.html', 'admin.css', 'admin.js', '404.html'
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(dist, file));
await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'examples'), resolve(dist, 'examples'), { recursive: true });

// Cloudflare Pages Advanced Mode runs a Module Worker placed at dist/_worker.js.
// Pages' ASSETS binding expects extensionless "pretty paths", not physical .html names.
const workerSource = await readFile(resolve(root, 'worker/src/index.js'), 'utf8');
const pagesWorker = workerSource
  .replace("serveAsset(env, request, '/lecture.html')", "serveAsset(env, request, '/lecture')")
  .replace("serveAsset(env, request, '/admin.html')", "serveAsset(env, request, '/admin')");

if (pagesWorker === workerSource) {
  throw new Error('Pages asset-route patch was not applied; Worker source changed unexpectedly.');
}

await writeFile(resolve(dist, '_worker.js'), pagesWorker);

console.log(`Built Pages assets and Advanced Mode worker in ${dist}`);

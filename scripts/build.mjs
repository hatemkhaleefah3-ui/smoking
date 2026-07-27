import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
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
// The shared Worker source now uses Pages-compatible pretty asset paths directly.
await cp(resolve(root, 'worker/src/index.js'), resolve(dist, '_worker.js'));

// A second Cloudflare Workers build is connected to the same repository. Wrangler
// must not publish the Pages server module as a public static asset.
await writeFile(resolve(dist, '.assetsignore'), '_worker.js\n');

console.log(`Built Pages assets and dual-deployment safeguards in ${dist}`);

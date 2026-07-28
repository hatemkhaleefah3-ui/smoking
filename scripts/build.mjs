import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const files = [
  'index.html', 'styles.css', 'app.js', 'lecture-renderer.js',
  'smart-media-search.css', 'smart-media-search.js',
  'lecture.html', 'lecture.js', 'admin.html', 'admin.css', 'admin.js', '404.html'
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(resolve(root, file), resolve(dist, file));
await cp(resolve(root, 'templates'), resolve(dist, 'templates'), { recursive: true });
await cp(resolve(root, 'examples'), resolve(dist, 'examples'), { recursive: true });

// Cloudflare Pages Advanced Mode runs a Module Worker placed at dist/_worker.js.
// Copy the router and its local modules together so Pages and Workers share the same API behavior.
await cp(resolve(root, 'worker/src/pages.js'), resolve(dist, '_worker.js'));
await cp(resolve(root, 'worker/src/index.js'), resolve(dist, 'index.js'));
await cp(resolve(root, 'worker/src/media-search.js'), resolve(dist, 'media-search.js'));

// Keep Worker modules out of the public static asset manifest while leaving them available to the module bundler.
await writeFile(resolve(dist, '.assetsignore'), '_worker.js\nindex.js\nmedia-search.js\n');

console.log(`Built Pages assets and dual-deployment safeguards in ${dist}`);

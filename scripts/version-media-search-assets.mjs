import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function versionMediaSearchAssets(distDirectory) {
  const indexPath = resolve(distDirectory, 'index.html');
  const jsPath = resolve(distDirectory, 'image-candidate-carousel.js');
  const cssPath = resolve(distDirectory, 'image-candidate-carousel.css');
  const [htmlSource, jsSource, cssSource] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(jsPath, 'utf8'),
    readFile(cssPath, 'utf8')
  ]);

  const digest = createHash('sha256')
    .update(jsSource)
    .update('\0')
    .update(cssSource)
    .digest('hex')
    .slice(0, 12);
  const jsName = `image-candidate-carousel.${digest}.js`;
  const cssName = `image-candidate-carousel.${digest}.css`;

  await Promise.all([
    copyFile(jsPath, resolve(distDirectory, jsName)),
    copyFile(cssPath, resolve(distDirectory, cssName))
  ]);

  let html = htmlSource
    .replace('href="image-candidate-carousel.css"', `href="${cssName}"`)
    .replace('src="image-candidate-carousel.js"', `src="${jsName}"`)
    .replace('<html lang="en">', `<html lang="en" data-media-search-build="${digest}">`)
    .replace(
      '<span class="version-badge">Schema v1.0 + v2.0 + v2.1</span>',
      `<span class="version-badge">Schema v1.0 + v2.0 + v2.1 · Media ${digest}</span>`
    );
  if (html === htmlSource) throw new Error('Media search asset versioning did not modify index.html.');
  await writeFile(indexPath, html, 'utf8');

  await writeFile(resolve(distDirectory, '_headers'), [
    '/',
    '  Cache-Control: no-store, max-age=0, must-revalidate',
    '/index.html',
    '  Cache-Control: no-store, max-age=0, must-revalidate',
    '/image-candidate-carousel.*.js',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/image-candidate-carousel.*.css',
    '  Cache-Control: public, max-age=31536000, immutable',
    ''
  ].join('\n'), 'utf8');

  return { digest, jsName, cssName };
}

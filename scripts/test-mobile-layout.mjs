import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const css = await readFile(new URL('../dist/mobile-studio.css', import.meta.url), 'utf8');
const bottomNavCss = await readFile(new URL('../dist/mobile-bottom-nav.css', import.meta.url), 'utf8');
const styles = await readFile(new URL('../dist/styles.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');

assert.match(html, /viewport-fit=cover/);
assert.match(styles, /mobile-studio\.css/);
assert.match(styles, /mobile-bottom-nav\.css/);
assert.match(css, /@media \(max-width: 780px\)/);
assert.match(css, /safe-area-inset-bottom/);
assert.match(css, /\.primary-nav/);
assert.match(css, /position:\s*fixed/);
assert.match(css, /\.wizard-progress/);
assert.match(css, /position:\s*sticky/);
assert.match(css, /\.media-results-grid/);
assert.match(css, /\.pdf-extractor-grid/);
assert.match(css, /prefers-reduced-motion/);
assert.match(bottomNavCss, /@media \(max-width: 900px\), \(max-width: 1024px\) and \(pointer: coarse\)/);
assert.match(bottomNavCss, /position:\s*fixed\s*!important/);
assert.match(bottomNavCss, /bottom:\s*max\([^;]+safe-area-inset-bottom/);
assert.match(bottomNavCss, /z-index:\s*1000\s*!important/);
assert.match(bottomNavCss, /grid-template-columns:\s*repeat\(4/);
assert.match(bottomNavCss, /padding-bottom:[^;]+safe-area-inset-bottom/);
await access(new URL('../dist/mobile-studio.css', import.meta.url));
await access(new URL('../dist/mobile-bottom-nav.css', import.meta.url));

console.log('Mobile responsive layout and fixed bottom navigation validation passed.');

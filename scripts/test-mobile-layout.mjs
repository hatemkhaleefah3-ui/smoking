import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const css = await readFile(new URL('../dist/mobile-studio.css', import.meta.url), 'utf8');
const bottomNavCss = await readFile(new URL('../dist/mobile-bottom-nav.css', import.meta.url), 'utf8');
const responsiveCss = await readFile(new URL('../dist/responsive-blue-studio.css', import.meta.url), 'utf8');
const styles = await readFile(new URL('../dist/styles.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');

assert.match(html, /viewport-fit=cover/);
assert.match(styles, /mobile-studio\.css/);
assert.match(styles, /mobile-bottom-nav\.css/);
assert.match(styles, /responsive-blue-studio\.css/);
assert.match(css, /@media \(max-width: 780px\)/);
assert.match(css, /safe-area-inset-bottom/);
assert.match(css, /\.wizard-progress/);
assert.match(css, /position:\s*sticky/);
assert.match(css, /\.media-results-grid/);
assert.match(css, /\.pdf-extractor-grid/);
assert.match(bottomNavCss, /position:\s*fixed\s*!important/);

// Blue theme replaces the old lime accent at the final cascade layer.
assert.match(responsiveCss, /--studio-accent:\s*#4da3ff/i);
assert.match(responsiveCss, /--studio-accent-hover:\s*#74b8ff/i);
assert.match(responsiveCss, /linear-gradient\(145deg, #80c5ff, var\(--studio-accent\)\)/i);

// Laptop: navigation stays above and centered in the top bar.
assert.match(responsiveCss, /@media \(min-width: 1200px\)/);
assert.match(responsiveCss, /grid-template-columns:\s*repeat\(4, 54px\)\s*!important/);
assert.match(responsiveCss, /position:\s*static\s*!important/);

// iPad/tablet: navigation is a fixed vertical rail beside the page.
assert.match(responsiveCss, /@media \(min-width: 768px\) and \(max-width: 1199px\)/);
assert.match(responsiveCss, /left:\s*var\(--tablet-rail-gap\)\s*!important/);
assert.match(responsiveCss, /grid-template-rows:\s*repeat\(4, 62px\)\s*!important/);
assert.match(responsiveCss, /transform:\s*translateY\(-50%\)\s*!important/);

// Phone: navigation is fixed below in four equal, centered cells.
assert.match(responsiveCss, /@media \(max-width: 767px\)/);
assert.match(responsiveCss, /bottom:\s*max\(var\(--phone-edge\), env\(safe-area-inset-bottom\)\)\s*!important/);
assert.match(responsiveCss, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)\s*!important/);
assert.match(responsiveCss, /place-items:\s*center\s*!important/);
assert.match(responsiveCss, /z-index:\s*5000\s*!important/);
assert.match(responsiveCss, /padding-bottom:[^;]+safe-area-inset-bottom/);

// Landscape phones remain bottom-nav layouts rather than becoming tablet rails.
assert.match(responsiveCss, /@media \(max-height: 560px\) and \(pointer: coarse\)/);

await access(new URL('../dist/mobile-studio.css', import.meta.url));
await access(new URL('../dist/mobile-bottom-nav.css', import.meta.url));
await access(new URL('../dist/responsive-blue-studio.css', import.meta.url));

console.log('Responsive blue laptop, tablet and phone layout validation passed.');

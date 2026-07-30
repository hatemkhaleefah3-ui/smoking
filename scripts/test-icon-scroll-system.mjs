import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const css = await readFile(new URL('../dist/icon-scroll-system.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../dist/icon-scroll-system.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../dist/styles.css', import.meta.url), 'utf8');
const shell = await readFile(new URL('../dist/site-shell.js', import.meta.url), 'utf8');

assert.match(styles, /icon-scroll-system\.css/);
assert.match(shell, /icon-scroll-system\.js/);
assert.match(css, /\.icon-only-control/);
assert.match(css, /scroll-snap-type:\s*x mandatory/);
assert.match(css, /direction:\s*ltr/);
assert.match(css, /safe-area-inset-bottom/);
assert.match(css, /\[data-slide-kind="image"\]/);
assert.match(js, /CONTROL_SELECTOR/);
assert.match(js, /\.primary-nav a/);
assert.match(js, /setAttribute\('aria-label'/);
assert.match(js, /repairChangedControl/);
assert.match(js, /MutationObserver/);
assert.match(js, /\.image-candidate-viewport/);
assert.match(js, /\.media-results-grid/);
assert.match(js, /ArrowLeft/);
assert.match(js, /ArrowRight/);

await access(new URL('../dist/icon-scroll-system.css', import.meta.url));
await access(new URL('../dist/icon-scroll-system.js', import.meta.url));

console.log('Icon-only controls and horizontal slide validation passed.');

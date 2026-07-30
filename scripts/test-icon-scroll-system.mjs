import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const base = new URL('../dist/', import.meta.url);
const [styles, integration, iconScript, iconStyles] = await Promise.all([
  readFile(new URL('styles.css', base), 'utf8'),
  readFile(new URL('studio-integration.js', base), 'utf8'),
  readFile(new URL('icon-scroll-system.js', base), 'utf8'),
  readFile(new URL('icon-scroll-system.css', base), 'utf8')
]);

assert.match(styles, /icon-scroll-system\.css/, 'The production stylesheet must load the icon and scrolling layer.');
assert.match(integration, /icon-scroll-system\.js/, 'The production page integration must load the icon runtime.');
assert.match(iconScript, /const CONTROL_SELECTOR/, 'The icon runtime must cover interactive controls.');
assert.match(iconScript, /MutationObserver/, 'Dynamically generated and relabeled controls must stay icon-only.');
assert.match(iconScript, /aria-label/, 'Icon-only controls must retain accessible names.');
assert.match(iconScript, /ArrowLeft/, 'Horizontal tracks must support keyboard scrolling.');
assert.match(iconScript, /ArrowRight/, 'Horizontal tracks must support keyboard scrolling.');
assert.match(iconStyles, /\.icon-only-control/, 'The icon-only control style must be present.');
assert.match(iconStyles, /overflow-x:\s*auto/, 'Card and image collections must scroll horizontally.');
assert.match(iconStyles, /scroll-snap-type:\s*x mandatory/, 'Horizontal collections must use snap points.');
assert.match(iconStyles, /direction:\s*ltr/, 'Horizontal collections must move from left to right.');
assert.match(iconStyles, /safe-area-inset-bottom/, 'The icon navigation must preserve phone safe areas.');
assert.match(iconStyles, /\[data-slide-kind="image"\]/, 'Image collections must have dedicated slide sizing.');

await access(new URL('icon-scroll-system.js', base));
await access(new URL('icon-scroll-system.css', base));

console.log('Icon-only controls and left-to-right horizontal slide collections validated.');
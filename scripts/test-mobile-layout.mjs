import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const css = await readFile(new URL('../dist/studio-rebuild.css', import.meta.url), 'utf8');
const refinements = await readFile(new URL('../dist/studio-refinements.css', import.meta.url), 'utf8');
const refinementController = await readFile(new URL('../dist/studio-refinements.js', import.meta.url), 'utf8');
const extractor = await readFile(new URL('../dist/pdf-extractor.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../dist/styles.css', import.meta.url), 'utf8');
const shell = await readFile(new URL('../dist/site-shell.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');

assert.match(html, /viewport-fit=cover/);
assert.match(styles, /studio-rebuild\.css/);
assert.match(styles, /studio-refinements\.css/);
assert.doesNotMatch(styles, /mobile-studio\.css/);
assert.doesNotMatch(styles, /mobile-bottom-nav\.css/);
assert.doesNotMatch(styles, /responsive-blue-studio\.css/);

// Navigation is structurally moved outside the header before route setup.
assert.match(shell, /primaryNav\.classList\.add\('app-navigation'\)/);
assert.match(shell, /document\.body\.insertBefore\(primaryNav, appMain\)/);
assert.match(shell, /data-root-navigation/);
assert.match(shell, /studio-refinements\.js/);

// New blue/light product language.
assert.match(css, /--studio-accent:\s*#2563eb/i);
assert.match(css, /color-scheme:\s*light/);
assert.match(css, /Completely new home composition/);
assert.match(css, /background:\s*linear-gradient\(145deg, #1d4ed8, #2563eb/);

// Laptop: centered top navigation.
assert.match(css, /@media \(min-width: 1200px\)/);
assert.match(css, /top:\s*14px\s*!important/);
assert.match(css, /left:\s*50%\s*!important/);
assert.match(css, /grid-template-columns:\s*repeat\(4, 1fr\)\s*!important/);
assert.match(css, /translateX\(-50%\)/);

// iPad/tablet: fixed vertical side rail.
assert.match(css, /@media \(min-width: 769px\) and \(max-width: 1199px\) and \(min-height: 600px\)/);
assert.match(css, /left:\s*14px\s*!important/);
assert.match(css, /grid-template-rows:\s*repeat\(4, 1fr\)\s*!important/);
assert.match(css, /translateY\(-50%\)/);

// Phone: full-width navigation at the actual lower viewport edge.
assert.match(css, /@media \(max-width: 768px\), \(max-width: 920px\) and \(max-height: 590px\)/);
assert.match(css, /bottom:\s*0\s*!important/);
assert.match(css, /left:\s*0\s*!important/);
assert.match(css, /right:\s*0\s*!important/);
assert.match(css, /width:\s*100%\s*!important/);
assert.match(css, /grid-template-columns:\s*repeat\(4, minmax\(0,1fr\)\)\s*!important/);
assert.match(css, /padding:\s*0 8px env\(safe-area-inset-bottom\)/);
assert.match(css, /border-radius:\s*22px 22px 0 0\s*!important/);
assert.match(css, /place-items:\s*center\s*!important/);

// Requested refinement pass.
assert.match(refinements, /\.topbar\s*\{\s*display:\s*none\s*!important/);
assert.match(refinementController, /home-know-more/);
assert.match(refinementController, /Know more/);
assert.match(refinements, /AMINO-ACID CONVERSION/);
assert.match(refinements, /NH₂—CH₂—COOH/);
assert.match(refinements, /\.app-navigation > a\.is-active::before/);
assert.match(refinements, /\.search-input-wrap:focus-within/);
assert.match(refinements, /grid-template-columns:\s*52px minmax\(0,1fr\) 58px/);

// Extractor uses visual targeting controls instead of a visible JSON editor.
assert.match(extractor, /MAX_TARGET_IMAGES/);
assert.match(extractor, /id="pdf-target-count"/);
assert.match(extractor, /pdf-image-target-card/);
assert.match(extractor, /data-target-field="page"/);
assert.match(extractor, /data-target-field="position"/);
assert.match(extractor, /JSON\.stringify\(\{ images \}\)/);
assert.match(refinements, /\.pdf-image-targets/);
assert.match(refinements, /scroll-snap-type:\s*x mandatory/);

await access(new URL('../dist/studio-rebuild.css', import.meta.url));
await access(new URL('../dist/studio-refinements.css', import.meta.url));
await access(new URL('../dist/studio-refinements.js', import.meta.url));
console.log('Rebuilt device layouts and requested UI refinements validation passed.');

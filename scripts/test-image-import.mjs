import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = { window: {}, structuredClone };
vm.createContext(context);
vm.runInContext(await readFile(new URL('../image-import.js', import.meta.url), 'utf8'), context);
const workflow = context.window.ImageImportWorkflow;

const source = {
  schemaVersion: '2.0',
  document: {
    title: 'Image workflow',
    sections: [{
      id: 'intro',
      title: 'Introduction',
      blocks: [
        { type: 'image', id: 'heart', label: 'Human heart anatomy', altText: 'Heart', src: '' },
        {
          type: 'columns',
          columns: [{
            blocks: [{ type: 'image', altText: 'Histology slide', src: 'https://example.com/slide.jpg' }]
          }]
        }
      ]
    }]
  }
};

const slots = workflow.collectImageSlots(source);
assert.equal(slots.length, 2);
assert.equal(slots[0].label, 'Human heart anatomy');
assert.equal(slots[0].sectionTitle, 'Introduction');
assert.equal(slots[0].required, true);
assert.equal(slots[1].label, 'Histology slide');
assert.equal(slots[1].required, false);

const enriched = workflow.applyImageSources(source, [
  { path: slots[0].path, src: 'https://publisher.example/api/images/11111111-1111-4111-8111-111111111111.png' }
]);
assert.equal(source.document.sections[0].blocks[0].src, '');
assert.match(enriched.document.sections[0].blocks[0].src, /\/api\/images\//);
assert.equal(enriched.document.sections[0].blocks[1].columns[0].blocks[0].src, 'https://example.com/slide.jpg');

assert.equal(workflow.validateImageFile({ type: 'image/png', size: 1024 }), '');
assert.match(workflow.validateImageFile({ type: 'image/svg+xml', size: 1024 }), /JPEG/);
assert.match(workflow.validateImageFile({ type: 'image/png', size: 9 * 1024 * 1024 }), /8 MB/);

console.log('Labeled image import workflow validation passed.');

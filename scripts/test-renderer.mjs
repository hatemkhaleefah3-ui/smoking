import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readIntegratedAssets } from './integrated-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const integratedAssets = await readIntegratedAssets(root);
const context = { window: {}, URL, console };
vm.createContext(context);
vm.runInContext(await readFile(new URL('../lecture-renderer.js', import.meta.url), 'utf8'), context);
vm.runInContext(await readFile(new URL('../clinical-v2-adapter.js', import.meta.url), 'utf8'), context);
vm.runInContext(integratedAssets.adapter, context);
const renderer = context.window.LectureRenderer;
const input = JSON.parse(await readFile(new URL('../examples/lecture-output.example.json', import.meta.url), 'utf8'));
const normalized = renderer.normalize(input);
for (const [design, filename] of Object.entries({
  classic: 'lecture-template.html',
  enhanced: 'lecture-template-enhanced.html',
  editorial: 'lecture-template-editorial.html',
  clinical: 'lecture-template-clinical.html'
})) {
  const template = await readFile(new URL(`../templates/${filename}`, import.meta.url), 'utf8');
  const html = renderer.render(normalized, template, design);
  if (!html.includes(normalized.document.title)) throw new Error(`${design} did not render the title.`);
  if (/{{[A-Z0-9_]+}}/.test(html)) throw new Error(`${design} has unresolved template tokens.`);
  if (!html.includes('lecture-section')) throw new Error(`${design} did not render lecture sections.`);
}

const clinicalV2Input = {
  schemaVersion: '2.0',
  document: {
    title: 'Clinical schema compatibility',
    language: 'en',
    sections: [{
      id: 'advanced-blocks',
      title: 'Advanced blocks',
      blocks: [
        { type: 'quote', text: 'Quoted text', cite: 'Clinical source' },
        { type: 'callout', tone: 'red-flag', title: 'Red flag', text: 'Urgent finding.' },
        { type: 'list', style: 'clinical', tone: 'treatment', header: 'Treatment', items: ['First intervention'] },
        { type: 'table', style: 'classification', caption: 'Clinical stages', headers: ['Stage', 'Finding'], rows: [['I', 'Mild']] },
        { type: 'image', id: 'img-001', label: 'Figure 1', altText: 'Anatomical diagram', src: '', aspectRatio: '4/3', width: 'half' },
        { type: 'pathway', style: 'linear', title: 'Linear', steps: [{ label: 'Start' }, { label: 'Finish', description: 'Outcome' }] },
        { type: 'pathway', style: 'branching', title: 'Branching', root: { label: 'Start', branches: [{ condition: 'Yes', label: 'Continue' }] } },
        { type: 'pathway', style: 'cyclical', title: 'Cycle', steps: ['One', 'Two', 'Three'] },
        { type: 'pathway', style: 'biochemical', title: 'Biochemical', chain: [{ substrate: 'A', enzyme: 'Enzyme', product: 'B' }] },
        { type: 'pathway', style: 'histology', title: 'Layers', layers: [{ name: 'Outer', description: 'Description', color: '#123456' }] }
      ]
    }]
  }
};
const clinicalV2 = renderer.normalize(clinicalV2Input);
if (clinicalV2.schemaVersion !== '2.1') throw new Error('Schema 2.0 was not normalized to 2.1.');
const clinicalTemplate = await readFile(new URL('../templates/lecture-template-clinical.html', import.meta.url), 'utf8');
const clinicalHtml = renderer.render(clinicalV2, clinicalTemplate, 'clinical');
for (const marker of ['<cite>Clinical source</cite>', 'callout-warning', 'key-points', 'Clinical stages', 'cv2-placeholder', 'cv2-pathway-linear', 'cv2-pathway-branching', 'cv2-pathway-cyclical', 'cv2-pathway-biochemical', 'cv2-pathway-histology', 'clinical-v2-adapter-styles']) {
  if (!clinicalHtml.includes(marker)) throw new Error(`Clinical schema v2.0 did not render ${marker}.`);
}
if (/{{[A-Z0-9_]+}}/.test(clinicalHtml)) throw new Error('Clinical schema v2.0 has unresolved template tokens.');

const integratedInput = JSON.parse(integratedAssets.example);
const integrated = renderer.normalize(integratedInput);
if (integrated.schemaVersion !== '2.1') throw new Error('Integrated Pathways schema 2.0 was not normalized to 2.1.');
if (integrated._design !== 'integrated' || integrated._adapter !== 'integrated-pathways-v2') {
  throw new Error('Integrated Pathways design metadata was not preserved.');
}
const integratedHtml = renderer.render(integrated, integratedAssets.template, 'integrated');
for (const marker of [
  'pharma-flow', 'biochem-flow', 'histo-stack', 'patho-flow', 'linear-flow',
  'circular-diagram', 'image-block', 'callout-clinical', 'checklist', 'table-caption'
]) {
  if (!integratedHtml.includes(marker)) throw new Error(`Integrated Pathways did not render ${marker}.`);
}
const escapedIntegratedTitle = escapeHtmlForAssertion(integrated.document.title);
if (!integratedHtml.includes(escapedIntegratedTitle)) {
  throw new Error(`Integrated Pathways did not render its escaped example title: ${JSON.stringify(integrated.document.title)}.`);
}
if (/{{[A-Z0-9_]+}}/.test(integratedHtml)) throw new Error('Integrated Pathways has unresolved template tokens.');

console.log('Renderer validation passed for all five designs, Clinical schema v2.0, and exact Integrated Pathways ZIP assets.');

function escapeHtmlForAssertion(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

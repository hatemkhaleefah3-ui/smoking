import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = { window: {}, URL, console };
vm.createContext(context);
vm.runInContext(await readFile(new URL('../lecture-renderer.js', import.meta.url), 'utf8'), context);
const renderer = context.window.LectureRenderer;
const input = JSON.parse(await readFile(new URL('../examples/lecture-output.example.json', import.meta.url), 'utf8'));
const normalized = renderer.normalize(input);
for (const [design, filename] of Object.entries({
  classic: 'lecture-template.html',
  enhanced: 'lecture-template-enhanced.html',
  editorial: 'lecture-template-editorial.html'
})) {
  const template = await readFile(new URL(`../templates/${filename}`, import.meta.url), 'utf8');
  const html = renderer.render(normalized, template, design);
  if (!html.includes(normalized.document.title)) throw new Error(`${design} did not render the title.`);
  if (/{{[A-Z0-9_]+}}/.test(html)) throw new Error(`${design} has unresolved template tokens.`);
  if (!html.includes('lecture-section')) throw new Error(`${design} did not render lecture sections.`);
}
console.log('Renderer validation passed for all three designs.');

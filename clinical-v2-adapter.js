'use strict';

(function installClinicalV2Adapter(global) {
  const renderer = global.LectureRenderer;
  if (!renderer) throw new Error('LectureRenderer must load before Clinical v2 compatibility.');

  const baseNormalize = renderer.normalize;
  const baseRender = renderer.render;
  const markerPattern = /<p>\[\[CLINICAL_V2:([A-Za-z0-9%._~-]+)\]\]<\/p>/g;
  const styles = `<style id="clinical-v2-adapter-styles">
.cv2-media,.cv2-pathway{margin:24px 0}.cv2-media img,.cv2-placeholder{display:block;width:100%;aspect-ratio:var(--cv2-ratio,16/9);border:1px solid #e5e7eb;border-radius:12px;object-fit:contain;background:#f8fafc}.cv2-placeholder{display:grid;min-height:180px;place-items:center;padding:24px;border-style:dashed;color:#64748b;text-align:center}.cv2-media figcaption{margin-top:8px;color:#64748b;font-size:.85rem}.cv2-width-half{max-width:50%}.cv2-width-third{max-width:33.333%}.cv2-pathway{padding:18px;border:1px solid #e5e7eb;border-radius:14px;background:#f8fafc}.cv2-pathway h3{margin:0 0 14px}.cv2-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px}.cv2-card,.cv2-branch li,.cv2-layer{padding:13px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}.cv2-card strong,.cv2-layer strong{display:block;color:#111827}.cv2-card p,.cv2-layer p{margin:5px 0 0}.cv2-branch,.cv2-branch ul{padding-inline-start:22px}.cv2-branch li{margin:9px 0}.cv2-condition{display:inline-block;margin-inline-end:7px;padding:2px 7px;border-radius:999px;background:#dbeafe;color:#1e3a8a;font-size:.72rem;font-weight:700}.cv2-layer{margin:7px 0;border-inline-start:8px solid var(--cv2-color,#94a3b8)}@media(max-width:700px){.cv2-width-half,.cv2-width-third{max-width:100%}}
</style>`;

  renderer.normalize = function normalizeWithClinicalV2(input) {
    return baseNormalize(adaptInput(input));
  };

  renderer.render = function renderWithClinicalV2(data, template, designId) {
    let html = baseRender(data, template, designId);
    let usedAdvancedBlocks = false;
    html = html.replace(markerPattern, (_match, encoded) => {
      usedAdvancedBlocks = true;
      try { return renderAdvancedBlock(JSON.parse(decodeURIComponent(encoded))); }
      catch { return '<aside class="callout callout-warning"><p>Could not render this Clinical v2 block.</p></aside>'; }
    });
    if (usedAdvancedBlocks && !html.includes('clinical-v2-adapter-styles')) {
      html = html.replace('</head>', `${styles}</head>`);
    }
    return html;
  };

  function adaptInput(input) {
    if (!isObject(input) || input.schemaVersion !== '2.0') return input;
    const document = isObject(input.document) ? input.document : {};
    return {
      ...input,
      schemaVersion: '2.1',
      document: {
        ...document,
        sections: Array.isArray(document.sections)
          ? document.sections.map((section) => ({
              ...section,
              blocks: adaptBlocks(section.blocks)
            }))
          : document.sections
      }
    };
  }

  function adaptBlocks(blocks) {
    if (!Array.isArray(blocks)) return blocks;
    return blocks.flatMap((block) => adaptBlock(block));
  }

  function adaptBlock(block) {
    if (!isObject(block)) return [block];
    switch (block.type) {
      case 'quote':
        return [{ ...block, attribution: block.attribution || block.cite || '' }];
      case 'callout':
        return [{ ...block, tone: block.tone === 'red-flag' ? 'warning' : block.tone }];
      case 'list':
        if (block.style === 'clinical') {
          return [{ type: 'keyPoints', title: block.header || toneLabel(block.tone), items: stringItems(block.items) }];
        }
        return [{ ...block, style: block.style === 'ordered' ? 'ordered' : 'unordered' }];
      case 'table': {
        const output = [];
        if (clean(block.caption)) output.push({ type: 'heading', level: 4, text: clean(block.caption) });
        output.push({ type: 'table', headers: block.headers, rows: block.rows });
        return output;
      }
      case 'image':
      case 'pathway':
        return [{ type: 'paragraph', text: encodeMarker(block) }];
      case 'columns':
        return [{ ...block, columns: Array.isArray(block.columns)
          ? block.columns.map((column) => ({ ...column, blocks: adaptBlocks(column.blocks) }))
          : block.columns }];
      default:
        return [block];
    }
  }

  function encodeMarker(block) {
    const encoded = encodeURIComponent(JSON.stringify(block)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `[[CLINICAL_V2:${encoded}]]`;
  }

  function renderAdvancedBlock(block) {
    if (block.type === 'image') return renderImage(block);
    if (block.type === 'pathway') return renderPathway(block);
    return '';
  }

  function renderImage(block) {
    const alt = clean(block.altText) || clean(block.label) || 'Lecture image';
    const src = safeUrl(block.src);
    const ratio = /^(?:16\/9|4\/3|3\/2|1\/1|21\/9)$/.test(clean(block.aspectRatio)) ? clean(block.aspectRatio) : '16/9';
    const width = ['full', 'half', 'third'].includes(block.width) ? block.width : 'full';
    const visual = src
      ? `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" loading="lazy" decoding="async">`
      : `<div class="cv2-placeholder" role="img" aria-label="${escapeAttribute(alt)}">${escapeHtml(alt)}</div>`;
    return `<figure class="cv2-media cv2-width-${width}"${block.id ? ` id="${escapeAttribute(clean(block.id))}"` : ''} style="--cv2-ratio:${escapeAttribute(ratio)}">${visual}${clean(block.label) ? `<figcaption>${escapeHtml(clean(block.label))}</figcaption>` : ''}</figure>`;
  }

  function renderPathway(block) {
    const title = clean(block.title) ? `<h3>${escapeHtml(clean(block.title))}</h3>` : '';
    let content = '';
    if (block.style === 'linear') {
      content = cards((block.steps || []).map((step) => ({ title: clean(step?.label), text: clean(step?.description) })));
    } else if (block.style === 'cyclical') {
      content = cards((block.steps || []).map((step, index) => ({ title: `${index + 1}. ${clean(step)}`, text: '' })));
    } else if (block.style === 'biochemical') {
      content = cards((block.chain || []).map((item) => ({
        title: `${clean(item?.substrate)} -> ${clean(item?.product)}`,
        text: [clean(item?.enzyme), clean(item?.coenzyme)].filter(Boolean).join(' / ')
      })));
    } else if (block.style === 'histology') {
      content = `<div>${(block.layers || []).map((layer) => `<div class="cv2-layer" style="--cv2-color:${escapeAttribute(safeColor(layer?.color))}"><strong>${escapeHtml(clean(layer?.name))}</strong>${clean(layer?.description) ? `<p>${escapeHtml(clean(layer.description))}</p>` : ''}</div>`).join('')}</div>`;
    } else if (block.style === 'branching') {
      content = `<ul class="cv2-branch">${renderBranch(block.root, 0)}</ul>`;
    }
    return `<section class="cv2-pathway cv2-pathway-${escapeAttribute(clean(block.style) || 'unknown')}">${title}${content}</section>`;
  }

  function cards(items) {
    return `<div class="cv2-cards">${items.filter((item) => item.title).map((item) => `<div class="cv2-card"><strong>${escapeHtml(item.title)}</strong>${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}</div>`).join('')}</div>`;
  }

  function renderBranch(node, depth) {
    if (!isObject(node) || depth > 8) return '';
    const branches = Array.isArray(node.branches) ? node.branches : [];
    return `<li>${clean(node.condition) ? `<span class="cv2-condition">${escapeHtml(clean(node.condition))}</span>` : ''}<strong>${escapeHtml(clean(node.label) || 'Step')}</strong>${clean(node.description) ? `<p>${escapeHtml(clean(node.description))}</p>` : ''}${branches.length ? `<ul>${branches.map((branch) => renderBranch(branch, depth + 1)).join('')}</ul>` : ''}</li>`;
  }

  function toneLabel(tone) {
    return ({ 'red-flag': 'Red flags', 'key-point': 'Key points', treatment: 'Treatment' })[tone] || 'Clinical points';
  }
  function stringItems(value) { return Array.isArray(value) ? value.map(clean).filter(Boolean) : []; }
  function clean(value) { return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim(); }
  function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function safeUrl(value) { const text = clean(value); if (!text) return ''; try { const url = new URL(text); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } }
  function safeColor(value) { return /^#[0-9a-f]{3,8}$/i.test(clean(value)) ? clean(value) : '#94a3b8'; }
  function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
  function escapeAttribute(value) { return escapeHtml(value).replaceAll('`', '&#096;'); }
})(window);

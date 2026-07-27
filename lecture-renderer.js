'use strict';

(function exposeLectureRenderer(global) {
  const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi']);
  const DEFAULT_THEME = {
    accentColor: '#3459d1',
    accentMid: '#203d9f',
    accentSoft: '#a8b9f2',
    accentPale: '#edf1ff',
    heroGradient: { start: '#172554', end: '#3459d1' }
  };

  function normalize(input) {
    assert(isObject(input), 'Top-level JSON must be an object.');
    assert(['1.0', '2.1'].includes(input.schemaVersion), 'schemaVersion must be "1.0" or "2.1".');
    const source = input.document;
    assert(isObject(source), 'document must be an object.');

    const title = requiredString(source.title, 'document.title');
    const language = requiredString(source.language, 'document.language');
    const primaryLanguage = language.toLowerCase().split('-')[0];
    const direction = ['ltr', 'rtl'].includes(source.direction)
      ? source.direction
      : RTL_LANGUAGES.has(primaryLanguage) ? 'rtl' : 'ltr';

    assert(Array.isArray(source.sections) && source.sections.length > 0, 'document.sections must contain at least one section.');
    const seenIds = new Set();
    const sections = source.sections.map((section, sectionIndex) => {
      const path = `document.sections[${sectionIndex}]`;
      assert(isObject(section), `${path} must be an object.`);
      const id = requiredString(section.id, `${path}.id`);
      assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id), `${path}.id must be lowercase kebab-case.`);
      assert(!seenIds.has(id), `${path}.id must be unique.`);
      seenIds.add(id);
      assert(Array.isArray(section.blocks), `${path}.blocks must be an array.`);
      return {
        id,
        title: requiredString(section.title, `${path}.title`),
        icon: stringValue(section.icon),
        sectionSummaryLine: stringValue(section.sectionSummaryLine),
        blocks: section.blocks.map((block, blockIndex) => normalizeBlock(block, `${path}.blocks[${blockIndex}]`))
      };
    });

    return {
      schemaVersion: input.schemaVersion,
      document: {
        title,
        language,
        direction,
        course: stringValue(source.course),
        lectureNumber: stringValue(source.lectureNumber),
        lecturer: stringValue(source.lecturer),
        date: stringValue(source.date),
        readingTimeMinutes: nonNegativeNumber(source.readingTimeMinutes),
        summary: stringValue(source.summary),
        keywords: stringArray(source.keywords),
        learningObjectives: stringArray(source.learningObjectives),
        stats: objectArray(source.stats).map((item) => ({ value: stringValue(item.value), label: stringValue(item.label) })),
        sections,
        references: objectArray(source.references).map((item) => ({
          id: stringValue(item.id),
          text: requiredString(item.text, 'reference text'),
          url: safeUrl(item.url)
        })),
        glossary: objectArray(source.glossary).map((item) => ({
          term: requiredString(item.term, 'glossary term'),
          definition: requiredString(item.definition, 'glossary definition')
        })),
        theme: normalizeTheme(source.theme)
      }
    };
  }

  function normalizeTheme(theme) {
    const value = isObject(theme) ? theme : {};
    const hero = isObject(value.heroGradient) ? value.heroGradient : {};
    return {
      accentColor: colorValue(value.accentColor, DEFAULT_THEME.accentColor),
      accentMid: colorValue(value.accentMid, DEFAULT_THEME.accentMid),
      accentSoft: colorValue(value.accentSoft, DEFAULT_THEME.accentSoft),
      accentPale: colorValue(value.accentPale, DEFAULT_THEME.accentPale),
      heroGradient: {
        start: colorValue(hero.start, DEFAULT_THEME.heroGradient.start),
        end: colorValue(hero.end, DEFAULT_THEME.heroGradient.end)
      }
    };
  }

  function normalizeBlock(block, path) {
    assert(isObject(block), `${path} must be an object.`);
    const type = requiredString(block.type, `${path}.type`);

    switch (type) {
      case 'paragraph':
        return { type, text: requiredString(block.text, `${path}.text`) };
      case 'sectionSummary':
        return { type, title: stringValue(block.title) || 'Section summary', text: stringValue(block.text), points: stringArray(block.points) };
      case 'heading':
        return { type, level: [3, 4].includes(block.level) ? block.level : 3, text: requiredString(block.text, `${path}.text`) };
      case 'list':
        return { type, style: block.style === 'ordered' ? 'ordered' : 'unordered', items: stringArray(block.items, true) };
      case 'quote':
        return { type, text: requiredString(block.text, `${path}.text`), attribution: stringValue(block.attribution) };
      case 'callout': {
        const allowed = ['note', 'important', 'warning', 'definition', 'tip', 'success'];
        return { type, tone: allowed.includes(block.tone) ? block.tone : 'note', title: stringValue(block.title), text: requiredString(block.text, `${path}.text`) };
      }
      case 'table': {
        const headers = stringArray(block.headers, true);
        const rows = Array.isArray(block.rows) ? block.rows.map((row, rowIndex) => {
          assert(Array.isArray(row) && row.length === headers.length, `${path}.rows[${rowIndex}] must match the headers.`);
          return row.map(stringValue);
        }) : [];
        return { type, headers, rows };
      }
      case 'code':
        return { type, language: stringValue(block.language), code: requiredString(block.code, `${path}.code`) };
      case 'keyPoints':
        return { type, title: stringValue(block.title) || 'Key points', items: stringArray(block.items, true) };
      case 'steps':
        return { type, title: stringValue(block.title), items: objectArray(block.items).map((item, index) => ({ title: requiredString(item.title, `${path}.items[${index}].title`), text: requiredString(item.text, `${path}.items[${index}].text`) })) };
      case 'comparison':
        return { type, title: stringValue(block.title), leftTitle: stringValue(block.leftTitle), rightTitle: stringValue(block.rightTitle), rows: objectArray(block.rows).map((row) => ({ label: stringValue(row.label), left: stringValue(row.left), right: stringValue(row.right) })) };
      case 'timeline':
        return { type, items: objectArray(block.items).map((item) => ({ date: stringValue(item.date), title: requiredString(item.title, `${path} timeline title`), text: stringValue(item.text) })) };
      case 'columns':
        return { type, columns: objectArray(block.columns).map((column, columnIndex) => ({ title: stringValue(column.title), blocks: (Array.isArray(column.blocks) ? column.blocks : []).map((nested, nestedIndex) => normalizeBlock(nested, `${path}.columns[${columnIndex}].blocks[${nestedIndex}]`)) })) };
      case 'formula':
        return { type, title: stringValue(block.title), expression: requiredString(block.expression, `${path}.expression`), description: stringValue(block.description) };
      case 'glossary':
        return { type, items: objectArray(block.items).map((item) => ({ term: requiredString(item.term, `${path} glossary term`), definition: requiredString(item.definition, `${path} glossary definition`) })) };
      case 'divider':
        return { type };
      default:
        throw new Error(`${path}.type "${type}" is not supported.`);
    }
  }

  function render(data, template, designId = 'classic') {
    const documentData = data.document;
    const theme = documentData.theme;
    const objectives = renderObjectives(documentData.learningObjectives);
    const references = renderReferences(documentData.references);
    const glossary = renderGlossary(documentData.glossary);
    const sections = documentData.sections.map((section, index) => renderSection(section, index, designId)).join('');
    const templateHasDedicatedAreas = template.includes('{{OBJECTIVES_SECTION}}');
    const content = templateHasDedicatedAreas ? sections : objectives + sections + references + glossary;
    const metadata = [
      ['Lecture', documentData.lectureNumber],
      ['Lecturer', documentData.lecturer],
      ['Date', documentData.date],
      ['Reading', documentData.readingTimeMinutes ? `${documentData.readingTimeMinutes} min` : '']
    ].filter(([, value]) => value).map(([label, value]) => `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`).join('');

    const replacements = {
      LANGUAGE: escapeAttribute(documentData.language),
      DIRECTION: escapeAttribute(documentData.direction),
      META_DESCRIPTION: escapeAttribute(documentData.summary || `Lecture notes for ${documentData.title}`),
      DOCUMENT_TITLE: escapeHtml(documentData.title),
      COURSE_LABEL: escapeHtml([documentData.course, documentData.lectureNumber].filter(Boolean).join(' · ') || 'Lecture notes'),
      LECTURE_TITLE: escapeHtml(documentData.title),
      METADATA: metadata,
      HERO_STATS: renderStats(documentData.stats),
      KEYWORDS_BAR: documentData.keywords.length ? `<div class="keywords-bar">${documentData.keywords.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : '',
      SUMMARY_SECTION: documentData.summary ? `<section class="summary"><strong>Summary</strong><p>${escapeHtml(documentData.summary)}</p></section>` : '',
      OBJECTIVES_SECTION: objectives,
      CONTENT: content,
      REFERENCES_SECTION: references,
      GLOSSARY_SECTION: glossary,
      TABLE_OF_CONTENTS: renderToc(documentData.sections),
      HEADER_TOC: renderToc(documentData.sections),
      ACCENT_COLOR: cssColor(theme.accentColor),
      ACCENT_MID: cssColor(theme.accentMid),
      ACCENT_SOFT: cssColor(theme.accentSoft),
      ACCENT_PALE: cssColor(theme.accentPale),
      HERO_GRADIENT_START: cssColor(theme.heroGradient.start),
      HERO_GRADIENT_END: cssColor(theme.heroGradient.end),
      GENERATED_AT: new Date().toISOString().slice(0, 10),
      SCHEMA_VERSION: escapeHtml(data.schemaVersion)
    };

    const rendered = Object.entries(replacements).reduce((output, [token, value]) => output.split(`{{${token}}}`).join(value), template);
    return rendered.replace(/{{[A-Z0-9_]+}}/g, '');
  }

  function renderSection(section, index, designId) {
    const heading = designId === 'editorial'
      ? `<div class="section-kicker">Section ${pad(index + 1)}</div><h2>${escapeHtml(section.title)}</h2>`
      : `<h2>${section.icon ? `<span class="section-icon">${escapeHtml(section.icon)}</span>` : ''}${escapeHtml(section.title)}</h2>`;
    return `<section class="lecture-section" id="${escapeAttribute(section.id)}">${heading}${section.sectionSummaryLine ? `<p class="section-summary-line">${escapeHtml(section.sectionSummaryLine)}</p>` : ''}${section.blocks.map((block) => renderBlock(block, designId)).join('')}</section>`;
  }

  function renderBlock(block, designId) {
    switch (block.type) {
      case 'paragraph': return `<p>${escapeHtml(block.text)}</p>`;
      case 'heading': return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
      case 'list': { const tag = block.style === 'ordered' ? 'ol' : 'ul'; return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`; }
      case 'quote': return `<blockquote>${escapeHtml(block.text)}${block.attribution ? `<cite>${escapeHtml(block.attribution)}</cite>` : ''}</blockquote>`;
      case 'callout': return `<aside class="callout callout-${escapeAttribute(block.tone)}">${block.title ? `<strong class="callout-title">${escapeHtml(block.title)}</strong>` : ''}<p>${escapeHtml(block.text)}</p></aside>`;
      case 'table': return `<div class="table-wrap"><table><thead><tr>${block.headers.map((item) => `<th>${escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((item) => `<td>${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      case 'code': return `<pre><code>${escapeHtml(block.code)}</code></pre>`;
      case 'keyPoints': return `<aside class="key-points"><strong>${escapeHtml(block.title)}</strong><ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></aside>`;
      case 'sectionSummary': return `<div class="section-summary"><strong>${escapeHtml(block.title)}</strong>${block.text ? `<p>${escapeHtml(block.text)}</p>` : ''}${block.points.length ? `<ul>${block.points.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}</div>`;
      case 'steps': return `<div class="steps-block">${block.title ? `<h3>${escapeHtml(block.title)}</h3>` : ''}${block.items.map((item, index) => `<div class="step-item"><span>${pad(index + 1)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div></div>`).join('')}</div>`;
      case 'comparison': return `<div class="comparison-block">${block.title ? `<h3>${escapeHtml(block.title)}</h3>` : ''}<div class="comparison-head"><strong></strong><strong>${escapeHtml(block.leftTitle)}</strong><strong>${escapeHtml(block.rightTitle)}</strong></div>${block.rows.map((row) => `<div class="comparison-row"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.left)}</span><span>${escapeHtml(row.right)}</span></div>`).join('')}</div>`;
      case 'timeline': return `<div class="timeline-block">${block.items.map((item) => `<div class="timeline-item"><time>${escapeHtml(item.date)}</time><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div></div>`).join('')}</div>`;
      case 'columns': return `<div class="columns-block">${block.columns.map((column) => `<section class="column-card">${column.title ? `<h3>${escapeHtml(column.title)}</h3>` : ''}${column.blocks.map((nested) => renderBlock(nested, designId)).join('')}</section>`).join('')}</div>`;
      case 'formula': return `<figure class="formula-block"><figcaption>${escapeHtml(block.title)}</figcaption><div>${escapeHtml(block.expression)}</div>${block.description ? `<p>${escapeHtml(block.description)}</p>` : ''}</figure>`;
      case 'glossary': return renderGlossary(block.items, 'Block glossary');
      case 'divider': return '<hr class="block-divider">';
      default: return '';
    }
  }

  function renderObjectives(items) { return items.length ? `<section class="objectives-section"><h2>Learning objectives</h2><ol>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></section>` : ''; }
  function renderStats(items) { return items.length ? `<div class="hero-stats">${items.map((item) => `<div><strong>${escapeHtml(item.value)}</strong><span>${escapeHtml(item.label)}</span></div>`).join('')}</div>` : ''; }
  function renderReferences(items) { return items.length ? `<section class="references-section"><h2>References</h2><ol>${items.map((item) => `<li>${item.id ? `<strong>${escapeHtml(item.id)}</strong> ` : ''}${item.url ? `<a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.text)}</a>` : escapeHtml(item.text)}</li>`).join('')}</ol></section>` : ''; }
  function renderGlossary(items, title = 'Document glossary') { return items.length ? `<section class="glossary-block"><h2>${escapeHtml(title)}</h2><dl>${items.map((item) => `<div><dt>${escapeHtml(item.term)}</dt><dd>${escapeHtml(item.definition)}</dd></div>`).join('')}</dl></section>` : ''; }
  function renderToc(sections) { return sections.length ? `<nav class="toc" aria-label="Table of contents"><strong>Contents</strong><ol>${sections.map((section, index) => `<li><a href="#${escapeAttribute(section.id)}"><span>${pad(index + 1)}</span>${escapeHtml(section.title)}</a></li>`).join('')}</ol></nav>` : ''; }
  function countBlocks(blocks) { return blocks.reduce((total, block) => total + 1 + (block.type === 'columns' ? block.columns.reduce((sum, column) => sum + countBlocks(column.blocks), 0) : 0), 0); }
  function stripOptionalCodeFence(text) { const trimmed = text.trim(); const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i); return match ? match[1] : trimmed; }
  function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function objectArray(value) { return Array.isArray(value) ? value.filter(isObject) : []; }
  function stringArray(value, required = false) { if (!Array.isArray(value)) { if (required) throw new Error('Expected an array of strings.'); return []; } const output = value.map(stringValue).filter(Boolean); if (required && output.length === 0) throw new Error('Expected at least one item.'); return output; }
  function stringValue(value) { return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim(); }
  function requiredString(value, path) { const output = stringValue(value); assert(output, `${path} must be a non-empty string.`); return output; }
  function nonNegativeNumber(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
  function colorValue(value, fallback) { const output = stringValue(value); return /^#[0-9a-f]{3,8}$/i.test(output) ? output : fallback; }
  function safeUrl(value) { const output = stringValue(value); if (!output) return ''; try { const url = new URL(output); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } }
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
  function escapeAttribute(value) { return escapeHtml(value).replaceAll('`', '&#096;'); }
  function cssColor(value) { return /^#[0-9a-f]{3,8}$/i.test(value) ? value : DEFAULT_THEME.accentColor; }
  function pad(value) { return String(value).padStart(2, '0'); }

  global.LectureRenderer = { normalize, render, countBlocks, stripOptionalCodeFence };
})(window);

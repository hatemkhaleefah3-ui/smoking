'use strict';

const DESIGNS = {
  classic: {
    name: 'Classic Academic',
    templateUrl: 'templates/lecture-template.html'
  }
};
const EXAMPLE_URL = 'examples/lecture-output.example.json';
const SUPPORTED_SCHEMA_VERSION = '1.0';
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi']);

const elements = {
  fileInput: document.querySelector('#file-input'),
  buildButton: document.querySelector('#build-button'),
  previewButton: document.querySelector('#preview-button'),
  dropZone: document.querySelector('#drop-zone'),
  selectedFileName: document.querySelector('#selected-file-name'),
  status: document.querySelector('#status'),
  documentDetails: document.querySelector('#document-details'),
  detailTitle: document.querySelector('#detail-title'),
  detailLanguage: document.querySelector('#detail-language'),
  detailSections: document.querySelector('#detail-sections'),
  detailBlocks: document.querySelector('#detail-blocks'),
  designInputs: [...document.querySelectorAll('input[name="design"]')]
};

const state = {
  templates: new Map(),
  exampleData: null,
  selectedFile: null,
  documentData: null,
  generatedHtml: ''
};

initialize();

async function initialize() {
  bindEvents();

  try {
    const [template, example] = await Promise.all([
      loadTemplate(getSelectedDesignId()),
      loadExampleData()
    ]);

    state.templates.set(getSelectedDesignId(), template);
    state.exampleData = normalizeAndValidate(example);
    elements.previewButton.disabled = false;
    setStatus('Ready. Preview the example or choose a JSON file and select Build.', 'success');
  } catch (error) {
    setStatus(
      'Could not load the design or example lecture. Serve this repository through a web server or GitHub Pages instead of opening index.html directly.',
      'error'
    );
    console.error(error);
  }
}

function bindEvents() {
  elements.buildButton.addEventListener('click', buildSelectedFile);
  elements.previewButton.addEventListener('click', previewSelectedDesign);

  elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files[0];
    if (file) selectFile(file);
  });

  elements.designInputs.forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await loadTemplate(input.value);
        state.generatedHtml = '';
        setStatus(`Selected ${DESIGNS[input.value].name}. Preview will use this design.`, 'success');
      } catch (error) {
        setStatus(`Could not load the selected design: ${error.message}`, 'error');
      }
    });
  });

  for (const eventName of ['dragenter', 'dragover']) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add('is-dragging');
    });
  }

  for (const eventName of ['dragleave', 'drop']) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove('is-dragging');
    });
  }

  elements.dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (file) selectFile(file);
  });
}

function selectFile(file) {
  state.selectedFile = file;
  elements.selectedFileName.textContent = `Selected: ${file.name}`;
  setStatus(`Selected ${file.name}. Select Build to validate and prepare it.`, 'neutral');
}

async function buildSelectedFile() {
  const file = state.selectedFile || elements.fileInput.files[0];
  if (!file) {
    setStatus('Choose a JSON file first.', 'error');
    return;
  }

  await processFile(file);
}

async function processFile(file) {
  if (!file.name.toLowerCase().endsWith('.json')) {
    clearDocumentState();
    setStatus('The selected file must use the .json extension.', 'error');
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(stripOptionalCodeFence(text));
    await processDocument(parsed, file.name);
  } catch (error) {
    clearDocumentState();
    setStatus(`Build failed: ${error.message}`, 'error');
  }
}

async function processDocument(input, sourceName) {
  const normalized = normalizeAndValidate(input);
  const template = await loadTemplate(getSelectedDesignId());
  const generatedHtml = renderHtmlDocument(normalized, template);

  state.documentData = normalized;
  state.generatedHtml = generatedHtml;
  updateDocumentDetails(normalized);
  setStatus(`Built ${sourceName} successfully. Select Preview to open the lecture page.`, 'success');
}

async function previewSelectedDesign() {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) {
    setStatus('The preview window was blocked. Allow pop-ups for this site and try again.', 'error');
    return;
  }

  previewWindow.document.open();
  previewWindow.document.write('<!doctype html><title>Loading preview…</title><p style="font-family:system-ui;padding:24px">Loading lecture preview…</p>');
  previewWindow.document.close();

  try {
    const designId = getSelectedDesignId();
    const template = await loadTemplate(designId);
    const data = state.documentData || state.exampleData;
    assert(data, 'The example lecture is not available yet.');

    const html = state.documentData && state.generatedHtml
      ? state.generatedHtml
      : renderHtmlDocument(data, template);

    previewWindow.document.open();
    previewWindow.document.write(html);
    previewWindow.document.close();

    const sourceLabel = state.documentData ? 'built lecture' : 'example lecture';
    setStatus(`Opened the ${sourceLabel} with the ${DESIGNS[designId].name} design.`, 'success');
  } catch (error) {
    previewWindow.close();
    setStatus(`Could not open the preview: ${error.message}`, 'error');
  }
}

async function loadTemplate(designId) {
  const design = DESIGNS[designId];
  assert(design, `Design "${designId}" is not supported.`);

  if (state.templates.has(designId)) {
    return state.templates.get(designId);
  }

  const response = await fetch(design.templateUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Template request failed with status ${response.status}.`);
  }

  const template = await response.text();
  state.templates.set(designId, template);
  return template;
}

async function loadExampleData() {
  const response = await fetch(EXAMPLE_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Example request failed with status ${response.status}.`);
  }
  return response.json();
}

function getSelectedDesignId() {
  return elements.designInputs.find((input) => input.checked)?.value || 'classic';
}

function normalizeAndValidate(input) {
  assert(isPlainObject(input), 'The top-level JSON value must be an object.');
  assert(input.schemaVersion === SUPPORTED_SCHEMA_VERSION, `schemaVersion must be "${SUPPORTED_SCHEMA_VERSION}".`);
  assert(isPlainObject(input.document), 'document must be an object.');

  const source = input.document;
  const title = requireNonEmptyString(source.title, 'document.title');
  const language = requireNonEmptyString(source.language, 'document.language');
  const direction = normalizeDirection(source.direction, language);

  assert(Array.isArray(source.keywords), 'document.keywords must be an array.');
  assert(Array.isArray(source.sections) && source.sections.length > 0, 'document.sections must contain at least one section.');

  const seenIds = new Set();
  const sections = source.sections.map((section, sectionIndex) => {
    const path = `document.sections[${sectionIndex}]`;
    assert(isPlainObject(section), `${path} must be an object.`);

    const id = requireNonEmptyString(section.id, `${path}.id`);
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id), `${path}.id must be lowercase kebab-case.`);
    assert(!seenIds.has(id), `${path}.id must be unique.`);
    seenIds.add(id);

    const sectionTitle = requireNonEmptyString(section.title, `${path}.title`);
    assert(Array.isArray(section.blocks), `${path}.blocks must be an array.`);

    return {
      id,
      title: sectionTitle,
      blocks: section.blocks.map((block, blockIndex) => normalizeBlock(block, `${path}.blocks[${blockIndex}]`))
    };
  });

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    document: {
      title,
      language,
      direction,
      course: optionalString(source.course, 'document.course'),
      lectureNumber: optionalString(source.lectureNumber, 'document.lectureNumber'),
      lecturer: optionalString(source.lecturer, 'document.lecturer'),
      date: optionalString(source.date, 'document.date'),
      summary: optionalString(source.summary, 'document.summary'),
      keywords: [...new Set(source.keywords.map((keyword, index) => optionalString(keyword, `document.keywords[${index}]`)).filter(Boolean))],
      sections
    }
  };
}

function normalizeBlock(block, path) {
  assert(isPlainObject(block), `${path} must be an object.`);
  const type = requireNonEmptyString(block.type, `${path}.type`);

  switch (type) {
    case 'paragraph':
      return { type, text: requireNonEmptyString(block.text, `${path}.text`) };

    case 'heading': {
      assert(block.level === 3 || block.level === 4, `${path}.level must be 3 or 4.`);
      return { type, level: block.level, text: requireNonEmptyString(block.text, `${path}.text`) };
    }

    case 'list': {
      assert(block.style === 'unordered' || block.style === 'ordered', `${path}.style must be "unordered" or "ordered".`);
      assert(Array.isArray(block.items) && block.items.length > 0, `${path}.items must contain at least one item.`);
      return {
        type,
        style: block.style,
        items: block.items.map((item, index) => requireNonEmptyString(item, `${path}.items[${index}]`))
      };
    }

    case 'quote':
      return {
        type,
        text: requireNonEmptyString(block.text, `${path}.text`),
        attribution: optionalString(block.attribution, `${path}.attribution`)
      };

    case 'callout': {
      const allowedTones = ['note', 'important', 'warning', 'definition'];
      assert(allowedTones.includes(block.tone), `${path}.tone is not supported.`);
      return {
        type,
        tone: block.tone,
        title: optionalString(block.title, `${path}.title`),
        text: requireNonEmptyString(block.text, `${path}.text`)
      };
    }

    case 'table': {
      assert(Array.isArray(block.headers) && block.headers.length > 0, `${path}.headers must contain at least one header.`);
      assert(Array.isArray(block.rows), `${path}.rows must be an array.`);
      const headers = block.headers.map((header, index) => optionalString(header, `${path}.headers[${index}]`));
      const rows = block.rows.map((row, rowIndex) => {
        assert(Array.isArray(row), `${path}.rows[${rowIndex}] must be an array.`);
        assert(row.length === headers.length, `${path}.rows[${rowIndex}] must have ${headers.length} cells.`);
        return row.map((cell, cellIndex) => optionalString(cell, `${path}.rows[${rowIndex}][${cellIndex}]`));
      });
      return { type, headers, rows };
    }

    case 'code':
      return {
        type,
        language: optionalString(block.language, `${path}.language`),
        code: requireNonEmptyString(block.code, `${path}.code`)
      };

    default:
      throw new Error(`${path}.type "${type}" is not supported.`);
  }
}

function renderHtmlDocument(data, template) {
  const documentData = data.document;
  const metadata = [
    ['Lecture', documentData.lectureNumber],
    ['Lecturer', documentData.lecturer],
    ['Date', documentData.date]
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`)
    .join('');

  const summarySection = documentData.summary
    ? `<section class="summary"><strong>Summary</strong><p>${escapeHtml(documentData.summary)}</p></section>`
    : '';

  const content = documentData.sections.map(renderSection).join('\n');
  const courseLabel = [documentData.course, documentData.lectureNumber].filter(Boolean).join(' · ') || 'Lecture notes';
  const description = documentData.summary || `Lecture notes for ${documentData.title}`;

  const replacements = {
    LANGUAGE: escapeAttribute(documentData.language),
    DIRECTION: escapeAttribute(documentData.direction),
    META_DESCRIPTION: escapeAttribute(description),
    DOCUMENT_TITLE: escapeHtml(documentData.title),
    COURSE_LABEL: escapeHtml(courseLabel),
    LECTURE_TITLE: escapeHtml(documentData.title),
    METADATA: metadata,
    SUMMARY_SECTION: summarySection,
    CONTENT: content,
    GENERATED_AT: escapeHtml(new Date().toISOString().slice(0, 10))
  };

  return replaceTemplateTokens(template, replacements);
}

function renderSection(section) {
  return `<section class="lecture-section" id="${escapeAttribute(section.id)}">
    <h2>${escapeHtml(section.title)}</h2>
    ${section.blocks.map(renderBlock).join('\n')}
  </section>`;
}

function renderBlock(block) {
  switch (block.type) {
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`;
    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case 'list': {
      const tag = block.style === 'ordered' ? 'ol' : 'ul';
      return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
    }
    case 'quote': {
      const attribution = block.attribution ? `<cite>${escapeHtml(block.attribution)}</cite>` : '';
      return `<blockquote>${escapeHtml(block.text)}${attribution}</blockquote>`;
    }
    case 'callout': {
      const title = block.title ? `<span class="callout-title">${escapeHtml(block.title)}</span>` : '';
      return `<aside class="callout callout-${escapeAttribute(block.tone)}">${title}${escapeHtml(block.text)}</aside>`;
    }
    case 'table': {
      const head = `<thead><tr>${block.headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')}</tr></thead>`;
      const body = `<tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      return `<div class="table-wrap"><table>${head}${body}</table></div>`;
    }
    case 'code': {
      const languageClass = block.language ? ` class="language-${escapeAttribute(slugify(block.language))}"` : '';
      return `<pre><code${languageClass}>${escapeHtml(block.code)}</code></pre>`;
    }
    default:
      return '';
  }
}

function replaceTemplateTokens(template, replacements) {
  return Object.entries(replacements).reduce(
    (result, [token, value]) => result.split(`{{${token}}}`).join(value),
    template
  );
}

function updateDocumentDetails(data) {
  const documentData = data.document;
  const blockCount = documentData.sections.reduce((total, section) => total + section.blocks.length, 0);

  elements.detailTitle.textContent = documentData.title;
  elements.detailLanguage.textContent = `${documentData.language} (${documentData.direction})`;
  elements.detailSections.textContent = String(documentData.sections.length);
  elements.detailBlocks.textContent = String(blockCount);
  elements.documentDetails.hidden = false;
}

function stripOptionalCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

function clearDocumentState() {
  state.documentData = null;
  state.generatedHtml = '';
  elements.documentDetails.hidden = true;
}

function setStatus(message, type) {
  elements.status.textContent = message;
  elements.status.className = `status status-${type}`;
}

function normalizeDirection(direction, language) {
  if (direction === 'ltr' || direction === 'rtl') return direction;
  assert(direction === 'auto', 'document.direction must be "ltr", "rtl", or "auto".');
  const primaryLanguage = language.toLowerCase().split('-')[0];
  return RTL_LANGUAGES.has(primaryLanguage) ? 'rtl' : 'ltr';
}

function requireNonEmptyString(value, path) {
  assert(typeof value === 'string' && value.trim().length > 0, `${path} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value, path) {
  assert(typeof value === 'string', `${path} must be a string.`);
  return value.trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

function slugify(value) {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

'use strict';

const DESIGNS = {
  classic: { name: 'Classic Academic', templateUrl: 'templates/lecture-template.html' },
  enhanced: { name: 'Enhanced Modern', templateUrl: 'templates/lecture-template-enhanced.html' },
  editorial: { name: 'Editorial Journal', templateUrl: 'templates/lecture-template-editorial.html' }
};
const EXAMPLE_URL = 'examples/lecture-output.example.json';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const elements = {
  fileInput: document.querySelector('#file-input'),
  buildButton: document.querySelector('#build-button'),
  previewButton: document.querySelector('#preview-button'),
  copyButton: document.querySelector('#copy-link-button'),
  dropZone: document.querySelector('#drop-zone'),
  selectedFileName: document.querySelector('#selected-file-name'),
  status: document.querySelector('#status'),
  documentDetails: document.querySelector('#document-details'),
  detailTitle: document.querySelector('#detail-title'),
  detailLanguage: document.querySelector('#detail-language'),
  detailSections: document.querySelector('#detail-sections'),
  detailBlocks: document.querySelector('#detail-blocks'),
  publishedLink: document.querySelector('#published-link'),
  designInputs: [...document.querySelectorAll('input[name="design"]')]
};

const state = {
  templates: new Map(),
  exampleData: null,
  selectedFile: null,
  documentData: null,
  publication: null
};

initialize();

async function initialize() {
  bindEvents();
  selectDesignCard();
  try {
    const [template, example] = await Promise.all([loadTemplate(selectedDesignId()), fetchJson(EXAMPLE_URL)]);
    state.templates.set(selectedDesignId(), template);
    state.exampleData = LectureRenderer.normalize(example);
    elements.previewButton.disabled = false;
    setStatus('Ready. Preview the example or choose a JSON file and select Build.', 'success');
  } catch (error) {
    setStatus('Could not load the designs or example lecture. Open the deployed Cloudflare site or use a local web server.', 'error');
    console.error(error);
  }
}

function bindEvents() {
  elements.buildButton.addEventListener('click', buildSelectedFile);
  elements.previewButton.addEventListener('click', previewLecture);
  elements.copyButton.addEventListener('click', copyPublishedLink);
  elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files[0];
    if (file) chooseFile(file);
  });
  elements.designInputs.forEach((input) => input.addEventListener('change', async () => {
    selectDesignCard();
    clearPublication();
    try {
      await loadTemplate(input.value);
      setStatus(`Selected ${DESIGNS[input.value].name}. Preview will use this design.`, 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }));
  ['dragenter', 'dragover'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('is-dragging');
  }));
  elements.dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (file) chooseFile(file);
  });
}

function selectDesignCard() {
  document.querySelectorAll('.design-option').forEach((card) => {
    card.classList.toggle('is-selected', Boolean(card.querySelector('input')?.checked));
  });
}

function chooseFile(file) {
  state.selectedFile = file;
  clearPublication();
  elements.selectedFileName.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus('This file is larger than the current 25 MB publishing limit.', 'error');
    return;
  }
  setStatus(`Selected ${file.name}. Select Build to validate it.`, 'neutral');
}

async function buildSelectedFile() {
  const file = state.selectedFile || elements.fileInput.files[0];
  if (!file) return setStatus('Choose a JSON file first.', 'error');
  if (!file.name.toLowerCase().endsWith('.json')) return setStatus('The selected file must use the .json extension.', 'error');
  if (file.size > MAX_UPLOAD_BYTES) return setStatus('This file is larger than the current 25 MB publishing limit.', 'error');

  try {
    const text = await file.text();
    state.documentData = LectureRenderer.normalize(JSON.parse(LectureRenderer.stripOptionalCodeFence(text)));
    clearPublication();
    updateDocumentDetails(state.documentData);
    setStatus(`Built ${file.name} successfully. Select Preview to publish and open its permanent link.`, 'success');
  } catch (error) {
    state.documentData = null;
    clearPublication();
    elements.documentDetails.hidden = true;
    setStatus(`Build failed: ${error.message}`, 'error');
  }
}

async function previewLecture() {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) return setStatus('The preview window was blocked. Allow pop-ups and try again.', 'error');
  previewWindow.document.write('<!doctype html><title>Loading…</title><p style="font-family:system-ui;padding:24px">Preparing lecture preview…</p>');
  previewWindow.document.close();

  try {
    if (!state.documentData) {
      const template = await loadTemplate(selectedDesignId());
      const html = LectureRenderer.render(state.exampleData, template, selectedDesignId());
      previewWindow.document.open();
      previewWindow.document.write(html);
      previewWindow.document.close();
      setStatus(`Opened the example lecture with ${DESIGNS[selectedDesignId()].name}.`, 'success');
      return;
    }

    const publication = await publishCurrentLecture();
    previewWindow.location.replace(publication.url);
    setStatus(`Published “${state.documentData.document.title}”. Its permanent link is ready to share.`, 'success');
  } catch (error) {
    previewWindow.close();
    setStatus(`Could not publish the preview: ${error.message}`, 'error');
  }
}

async function publishCurrentLecture() {
  const designId = selectedDesignId();
  if (state.publication?.designId === designId) return state.publication;

  const payload = JSON.stringify(state.documentData);
  if (new Blob([payload]).size > MAX_UPLOAD_BYTES) throw new Error('The normalized lecture is larger than the 25 MB publishing limit.');

  const response = await fetch('/api/lectures', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Design-Id': designId,
      'X-Schema-Version': state.documentData.schemaVersion,
      'X-Lecture-Title': encodeURIComponent(state.documentData.document.title.slice(0, 200))
    },
    body: payload
  });
  const result = await readJsonResponse(response);
  if (!response.ok) throw new Error(result.error || 'Publishing failed.');

  state.publication = { id: result.id, url: result.url, designId };
  elements.copyButton.hidden = false;
  elements.copyButton.disabled = false;
  elements.publishedLink.hidden = false;
  elements.publishedLink.href = result.url;
  elements.publishedLink.textContent = result.url;
  return state.publication;
}

async function copyPublishedLink() {
  if (!state.publication) return;
  try {
    await navigator.clipboard.writeText(state.publication.url);
    setStatus('Permanent lecture link copied.', 'success');
  } catch {
    elements.publishedLink.focus();
    setStatus('Open the published link below and copy it from the address bar.', 'neutral');
  }
}

async function loadTemplate(designId) {
  if (state.templates.has(designId)) return state.templates.get(designId);
  const response = await fetch(DESIGNS[designId].templateUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${DESIGNS[designId].name}.`);
  const template = await response.text();
  state.templates.set(designId, template);
  return template;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the example JSON.');
  return response.json();
}

function selectedDesignId() {
  return elements.designInputs.find((input) => input.checked)?.value || 'classic';
}

function updateDocumentDetails(data) {
  const documentData = data.document;
  elements.detailTitle.textContent = documentData.title;
  elements.detailLanguage.textContent = `${documentData.language} (${documentData.direction})`;
  elements.detailSections.textContent = String(documentData.sections.length);
  elements.detailBlocks.textContent = String(documentData.sections.reduce((total, section) => total + LectureRenderer.countBlocks(section.blocks), 0));
  elements.documentDetails.hidden = false;
}

function clearPublication() {
  state.publication = null;
  elements.copyButton.hidden = true;
  elements.copyButton.disabled = true;
  elements.publishedLink.hidden = true;
  elements.publishedLink.removeAttribute('href');
  elements.publishedLink.textContent = '';
}

function setStatus(message, type) {
  elements.status.textContent = message;
  elements.status.className = `status status-${type}`;
}

async function readJsonResponse(response) {
  try { return await response.json(); } catch { return {}; }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

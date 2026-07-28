'use strict';

const DESIGNS = {
  classic: { name: 'Classic Academic', templateUrl: 'templates/lecture-template.html' },
  enhanced: { name: 'Enhanced Modern', templateUrl: 'templates/lecture-template-enhanced.html' },
  editorial: { name: 'Editorial Journal', templateUrl: 'templates/lecture-template-editorial.html' },
  clinical: { name: 'Clinical Notes', templateUrl: 'templates/lecture-template-clinical.html', storageDesignId: 'classic' },
  integrated: {
    name: 'Integrated Pathways',
    templateUrl: 'templates/lecture-template-integrated.html',
    storageDesignId: 'classic'
  }
};
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const clinicalStylesheet = document.createElement('link');
clinicalStylesheet.rel = 'stylesheet';
clinicalStylesheet.href = 'clinical-design.css';
document.head.append(clinicalStylesheet);

const elements = {
  fileInput: document.querySelector('#file-input'),
  buildButton: document.querySelector('#build-button'),
  continueButton: document.querySelector('#continue-button'),
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
  imageImportPanel: document.querySelector('#image-import-panel'),
  imageImportSummary: document.querySelector('#image-import-summary'),
  imageImportList: document.querySelector('#image-import-list'),
  publishedLink: document.querySelector('#published-link'),
  designInputs: [...document.querySelectorAll('input[name="design"]')]
};

const state = {
  templates: new Map(),
  selectedFile: null,
  sourceData: null,
  documentData: null,
  imageSlots: [],
  publication: null,
  busy: false
};

initialize();

async function initialize() {
  bindEvents();
  selectDesignCard();
  resetBuiltLecture();
  try {
    await loadTemplate(selectedDesignId());
    setStatus('Ready. Import a lecture JSON file and select Build.', 'success');
  } catch (error) {
    setStatus('Could not load the selected design. Open the deployed Cloudflare site or use a local web server.', 'error');
    console.error(error);
  }
}

function bindEvents() {
  elements.buildButton.addEventListener('click', buildSelectedFile);
  elements.continueButton.addEventListener('click', continueToPublication);
  elements.previewButton.addEventListener('click', previewPublishedLecture);
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
      if (state.documentData) {
        updateContinueAvailability();
        setStatus(`Selected ${DESIGNS[input.value].name}. Select Continue to create a link with this design.`, 'success');
      } else {
        setStatus(`Selected ${DESIGNS[input.value].name}. Import a JSON file and select Build.`, 'success');
      }
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }));
  ['dragenter', 'dragover'].forEach((name) => elements.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((name) => elements.dropZone.addEventListener(name, (event) => {
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

function selectDesignById(designId) {
  if (!DESIGNS[designId]) return false;
  const input = elements.designInputs.find((candidate) => candidate.value === designId);
  if (!input) return false;
  input.checked = true;
  selectDesignCard();
  return true;
}

function chooseFile(file) {
  state.selectedFile = file;
  resetBuiltLecture();
  elements.selectedFileName.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus('This JSON file is larger than the current 25 MB publishing limit.', 'error');
    return;
  }
  setStatus(`Selected ${file.name}. Select Build to validate it and discover its image labels.`, 'neutral');
}

async function buildSelectedFile() {
  const file = state.selectedFile || elements.fileInput.files[0];
  if (!file) return setStatus('Choose a JSON file first.', 'error');
  if (!file.name.toLowerCase().endsWith('.json')) return setStatus('The selected file must use the .json extension.', 'error');
  if (file.size > MAX_UPLOAD_BYTES) return setStatus('This JSON file is larger than the current 25 MB publishing limit.', 'error');

  setBusy(true, 'Building…');
  try {
    const text = await file.text();
    const sourceData = JSON.parse(LectureRenderer.stripOptionalCodeFence(text));
    const documentData = LectureRenderer.normalize(sourceData);

    state.sourceData = sourceData;
    state.documentData = documentData;
    state.imageSlots = ImageImportWorkflow.collectImageSlots(sourceData).map((slot) => ({
      ...slot,
      file: null,
      previewUrl: ''
    }));

    if (typeof documentData?._design === 'string' && selectDesignById(documentData._design)) {
      await loadTemplate(documentData._design);
    }

    clearPublication();
    updateDocumentDetails(documentData);
    renderImageImports();
    elements.continueButton.hidden = false;
    updateContinueAvailability();

    const imageMessage = state.imageSlots.length
      ? ` Import ${state.imageSlots.length} labeled image${state.imageSlots.length === 1 ? '' : 's'}, then select Continue.`
      : ' No image blocks were found; select Continue to publish.';
    setStatus(`Built ${file.name} successfully.${imageMessage}`, 'success');
  } catch (error) {
    resetBuiltLecture();
    setStatus(`Build failed: ${error.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

function renderImageImports() {
  elements.imageImportList.replaceChildren();
  elements.imageImportPanel.hidden = false;

  if (state.imageSlots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'image-import-empty';
    empty.textContent = 'This lecture has no image blocks. Continue to create the previewable link.';
    elements.imageImportList.append(empty);
    elements.imageImportSummary.textContent = 'No image imports required.';
    return;
  }

  state.imageSlots.forEach((slot, index) => {
    const card = document.createElement('article');
    card.className = 'image-import-item';
    card.dataset.ready = String(Boolean(slot.file || slot.existingSrc));

    const copy = document.createElement('div');
    copy.className = 'image-import-copy';
    const number = document.createElement('span');
    number.className = 'image-import-index';
    number.textContent = `Image ${String(index + 1).padStart(2, '0')}`;
    const label = document.createElement('strong');
    label.className = 'image-import-label';
    label.textContent = slot.label;
    const context = document.createElement('small');
    context.textContent = slot.sectionTitle
      ? `${slot.sectionTitle}${slot.existingSrc ? ' · Existing image can be replaced' : ' · Image required'}`
      : slot.existingSrc ? 'Existing image can be replaced' : 'Image required';
    copy.append(number, label, context);

    const preview = document.createElement('div');
    preview.className = 'image-import-preview';
    const previewSrc = slot.previewUrl || slot.existingSrc;
    if (previewSrc) {
      const image = document.createElement('img');
      image.src = previewSrc;
      image.alt = '';
      preview.append(image);
    } else {
      preview.textContent = 'No image selected';
    }

    const controls = document.createElement('div');
    controls.className = 'image-import-controls';
    const inputId = `${slot.id}-input`;
    const button = document.createElement('label');
    button.className = 'image-file-button';
    button.htmlFor = inputId;
    button.textContent = slot.file || slot.existingSrc ? 'Replace image' : 'Choose image';
    const input = document.createElement('input');
    input.id = inputId;
    input.type = 'file';
    input.accept = [...ImageImportWorkflow.ACCEPTED_IMAGE_TYPES].join(',');
    input.addEventListener('change', () => handleImageSelection(slot, input.files[0], input));
    const fileName = document.createElement('span');
    fileName.className = 'image-file-name';
    fileName.textContent = slot.file?.name || (slot.existingSrc ? 'Existing image ready' : 'JPEG, PNG, WebP, GIF or AVIF · max 8 MB');
    controls.append(button, input, fileName);

    card.append(copy, preview, controls);
    elements.imageImportList.append(card);
  });

  updateImageImportSummary();
}

function handleImageSelection(slot, file, input) {
  const error = ImageImportWorkflow.validateImageFile(file);
  if (error) {
    input.value = '';
    setStatus(`${slot.label}: ${error}`, 'error');
    return;
  }

  if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
  slot.file = file;
  slot.previewUrl = URL.createObjectURL(file);
  clearPublication();
  renderImageImports();
  updateContinueAvailability();
  setStatus(`Selected ${file.name} for “${slot.label}”.`, 'success');
}

function updateImageImportSummary() {
  const ready = state.imageSlots.filter((slot) => slot.file || slot.existingSrc).length;
  const total = state.imageSlots.length;
  elements.imageImportSummary.textContent = `${ready} of ${total} image${total === 1 ? '' : 's'} ready.`;
}

function updateContinueAvailability() {
  const allImagesReady = state.imageSlots.every((slot) => slot.file || slot.existingSrc);
  elements.continueButton.disabled = state.busy || !state.documentData || !allImagesReady;
  if (state.imageSlots.length) updateImageImportSummary();
}

async function continueToPublication() {
  if (!state.sourceData || !state.documentData) return setStatus('Build a JSON file first.', 'error');
  const missing = state.imageSlots.filter((slot) => !slot.file && !slot.existingSrc);
  if (missing.length) return setStatus(`Import the image labeled “${missing[0].label}” before continuing.`, 'error');

  clearPublication();
  setBusy(true, 'Preparing…');
  try {
    const pending = state.imageSlots.filter((slot) => slot.file);
    for (let index = 0; index < pending.length; index += 1) {
      const slot = pending[index];
      elements.continueButton.textContent = `Uploading ${index + 1}/${pending.length}…`;
      setStatus(`Uploading “${slot.label}” (${index + 1} of ${pending.length})…`, 'neutral');
      const uploaded = await uploadImage(slot.file, slot.label);
      state.sourceData = ImageImportWorkflow.applyImageSources(state.sourceData, [{ path: slot.path, src: uploaded.url }]);
      slot.existingSrc = uploaded.url;
      slot.file = null;
      if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
      slot.previewUrl = '';
    }

    state.documentData = LectureRenderer.normalize(state.sourceData);
    updateDocumentDetails(state.documentData);
    renderImageImports();
    elements.continueButton.textContent = 'Publishing…';
    const publication = await publishCurrentLecture();
    elements.previewButton.hidden = false;
    elements.previewButton.disabled = false;
    setStatus(`The previewable link for “${state.documentData.document.title}” is ready. Select Preview to open it.`, 'success');
    return publication;
  } catch (error) {
    renderImageImports();
    setStatus(`Could not prepare the previewable link: ${error.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function uploadImage(file, label) {
  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('label', label);
  const response = await fetch('/api/images', { method: 'POST', body: formData });
  const result = await readJsonResponse(response);
  if (!response.ok) throw new Error(result.error || `Image upload failed with status ${response.status}.`);
  if (typeof result.url !== 'string' || !result.url) throw new Error('The image service did not return a usable URL.');
  return result;
}

function previewPublishedLecture() {
  if (!state.publication?.url) return setStatus('Select Continue first so the previewable link can be created.', 'error');
  const previewWindow = window.open(state.publication.url, '_blank', 'noopener,noreferrer');
  if (!previewWindow) setStatus('The preview window was blocked. Allow pop-ups and try again.', 'error');
}

async function publishCurrentLecture() {
  const designId = selectedDesignId();
  if (state.publication?.designId === designId) return state.publication;
  const design = DESIGNS[designId];
  const storageDesignId = design.storageDesignId || designId;
  const publicationData = storageDesignId === designId ? state.documentData : { ...state.documentData, _design: designId };
  const payload = JSON.stringify(publicationData);
  if (new Blob([payload]).size > MAX_UPLOAD_BYTES) throw new Error('The normalized lecture is larger than the 25 MB publishing limit.');
  const response = await fetch('/api/lectures', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Design-Id': storageDesignId,
      'X-Schema-Version': state.documentData.schemaVersion,
      'X-Lecture-Title': encodeURIComponent(state.documentData.document.title.slice(0, 200))
    },
    body: payload
  });
  const result = await readJsonResponse(response);
  if (!response.ok) throw new Error(result.error || `Publishing failed with status ${response.status}.`);
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
  const design = DESIGNS[designId];
  if (!design) throw new Error('Unsupported lecture design.');
  const response = await fetch(design.templateUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${design.name}.`);
  const template = await response.text();
  state.templates.set(designId, template);
  return template;
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

function resetBuiltLecture() {
  revokeImagePreviews();
  state.sourceData = null;
  state.documentData = null;
  state.imageSlots = [];
  elements.documentDetails.hidden = true;
  elements.imageImportPanel.hidden = true;
  elements.imageImportList.replaceChildren();
  elements.continueButton.hidden = true;
  elements.continueButton.disabled = true;
  clearPublication();
}

function revokeImagePreviews() {
  state.imageSlots.forEach((slot) => {
    if (slot.previewUrl) URL.revokeObjectURL(slot.previewUrl);
  });
}

function clearPublication() {
  state.publication = null;
  elements.previewButton.hidden = true;
  elements.previewButton.disabled = true;
  elements.copyButton.hidden = true;
  elements.copyButton.disabled = true;
  elements.publishedLink.hidden = true;
  elements.publishedLink.removeAttribute('href');
  elements.publishedLink.textContent = '';
}

function setBusy(busy, buttonText = '') {
  state.busy = busy;
  elements.buildButton.disabled = busy;
  elements.fileInput.disabled = busy;
  elements.designInputs.forEach((input) => { input.disabled = busy; });
  if (busy) {
    elements.continueButton.disabled = true;
    if (buttonText) elements.continueButton.textContent = buttonText;
  } else {
    elements.continueButton.textContent = 'Continue';
    updateContinueAvailability();
  }
}

function setStatus(message, type) {
  elements.status.textContent = message;
  elements.status.className = `status status-${type}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.trim().slice(0, 300) || `Request failed with status ${response.status}.` };
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

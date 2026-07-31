'use strict';

(() => {
  const MAX_PDF_BYTES = 25 * 1024 * 1024;
  const MAX_RESULT_BYTES = 64 * 1024 * 1024;
  const MAX_TARGET_IMAGES = 12;
  const MAX_PAGE_NUMBER = 60;
  const MAX_PAGE_POSITION = 12;

  buildVisualSelector();

  const elements = {
    fileInput: document.querySelector('#pdf-file-input'),
    dropZone: document.querySelector('#pdf-drop-zone'),
    selectedFileName: document.querySelector('#pdf-selected-file-name'),
    selectors: document.querySelector('#pdf-images-json'),
    targetCount: document.querySelector('#pdf-target-count'),
    targetList: document.querySelector('#pdf-image-targets'),
    actionButton: document.querySelector('#pdf-extract-button'),
    status: document.querySelector('#pdf-extraction-status')
  };

  if (Object.values(elements).some((element) => !element)) return;

  const state = {
    selectedFile: null,
    downloadUrl: '',
    downloadFilename: ''
  };

  elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files?.[0];
    if (file) chooseFile(file);
  });
  elements.targetCount.addEventListener('change', () => {
    renderTargetCards(Number(elements.targetCount.value) || 0);
    resetDownload();
  });
  elements.targetList.addEventListener('click', handleTargetChoice);
  elements.actionButton.addEventListener('click', handleAction);

  ['dragenter', 'dragover'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('is-dragging');
  }));
  elements.dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) chooseFile(file);
  });

  renderTargetCards(0);

  function buildVisualSelector() {
    const panel = document.querySelector('.pdf-selector-panel');
    if (!panel) return;

    const countOptions = ['<option value="0">All embedded images</option>'];
    for (let number = 1; number <= MAX_TARGET_IMAGES; number += 1) {
      countOptions.push(`<option value="${number}">${number} image${number === 1 ? '' : 's'}</option>`);
    }

    panel.innerHTML = `
      <div class="selector-heading">
        <span>Optional</span>
        <strong>Choose specific images</strong>
      </div>
      <p class="pdf-selector-description">Leave this set to all images, or choose how many exact images you want to target.</p>
      <div class="pdf-target-count-row">
        <label for="pdf-target-count">
          Number of images
          <small>Open the list and select a number.</small>
        </label>
        <select id="pdf-target-count">${countOptions.join('')}</select>
      </div>
      <div id="pdf-image-targets" class="pdf-image-targets" hidden aria-label="Specific image selectors"></div>
      <textarea id="pdf-images-json" hidden aria-hidden="true"></textarea>
    `;
  }

  function renderTargetCards(count) {
    const safeCount = Math.max(0, Math.min(MAX_TARGET_IMAGES, Number(count) || 0));
    elements.targetList.replaceChildren();
    elements.targetList.hidden = safeCount === 0;

    if (safeCount === 0) {
      elements.selectors.value = '';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < safeCount; index += 1) {
      fragment.append(createTargetCard(index));
    }
    elements.targetList.append(fragment);
    syncSelectorJson();
  }

  function createTargetCard(index) {
    const card = document.createElement('article');
    card.className = 'pdf-image-target-card';
    card.dataset.page = '1';
    card.dataset.position = '1';
    card.dataset.targetIndex = String(index);
    card.innerHTML = `
      <header>
        <strong>Image ${index + 1}</strong>
        <span>${String(index + 1).padStart(2, '0')} / TARGET</span>
      </header>
      <div class="pdf-target-option-group">
        <strong>Page or slide containing this image</strong>
        <div class="pdf-number-rail" data-target-field="page" role="group" aria-label="Page for image ${index + 1}">
          ${numberChoices(MAX_PAGE_NUMBER, 1)}
        </div>
      </div>
      <div class="pdf-target-option-group">
        <strong>Image order on that page</strong>
        <div class="pdf-number-rail" data-target-field="position" role="group" aria-label="Order for image ${index + 1}">
          ${numberChoices(MAX_PAGE_POSITION, 1)}
        </div>
      </div>
    `;
    return card;
  }

  function numberChoices(maximum, selected) {
    let html = '';
    for (let number = 1; number <= maximum; number += 1) {
      const active = number === selected ? ' is-selected' : '';
      html += `<button class="pdf-number-choice${active}" type="button" data-number="${number}" aria-pressed="${number === selected}">${number}</button>`;
    }
    return html;
  }

  function handleTargetChoice(event) {
    const choice = event.target.closest('.pdf-number-choice');
    if (!choice || !elements.targetList.contains(choice)) return;

    const rail = choice.closest('.pdf-number-rail');
    const card = choice.closest('.pdf-image-target-card');
    const field = rail?.dataset.targetField;
    const value = Number(choice.dataset.number);
    if (!rail || !card || !['page', 'position'].includes(field) || !Number.isInteger(value)) return;

    rail.querySelectorAll('.pdf-number-choice').forEach((button) => {
      const selected = button === choice;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    card.dataset[field] = String(value);
    syncSelectorJson();
    resetDownload();
  }

  function syncSelectorJson() {
    const images = [...elements.targetList.querySelectorAll('.pdf-image-target-card')].map((card) => ({
      page: Number(card.dataset.page) || 1,
      position: Number(card.dataset.position) || 1
    }));
    elements.selectors.value = images.length ? JSON.stringify({ images }) : '';
  }

  function chooseFile(file) {
    state.selectedFile = file;
    resetDownload();
    elements.selectedFileName.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;

    const looksLikePdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!looksLikePdf) {
      setStatus('Choose a PDF file.', 'error');
      return;
    }
    if (file.size === 0) {
      setStatus('The selected PDF is empty.', 'error');
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setStatus('This PDF is larger than the current 25 MB extraction limit.', 'error');
      return;
    }
    setStatus(`Selected ${file.name}. Use the optional image selectors below, or extract every embedded image.`, 'neutral');
  }

  async function handleAction() {
    if (state.downloadUrl) {
      const link = document.createElement('a');
      link.href = state.downloadUrl;
      link.download = state.downloadFilename || '';
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      return;
    }

    const file = state.selectedFile || elements.fileInput.files?.[0];
    if (!file) return setStatus('Choose a PDF file first.', 'error');
    if (!(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) return setStatus('Choose a PDF file.', 'error');
    if (file.size === 0) return setStatus('The selected PDF is empty.', 'error');
    if (file.size > MAX_PDF_BYTES) return setStatus('This PDF is larger than the current 25 MB extraction limit.', 'error');

    setLoading(true);
    try {
      setStatus('Loading the PDF engine in your browser…', 'neutral');
      const { extractPdfArtifact } = await import('/pdf-extractor-runtime.js?v=structured-images-2');

      setStatus('Reading the PDF and extracting its embedded images…', 'neutral');
      const artifact = await extractPdfArtifact(file, elements.selectors.value);
      if (artifact.blob.size > MAX_RESULT_BYTES) {
        throw new Error('The extracted result is larger than the current 64 MB result limit.');
      }

      setStatus(`Uploading ${artifact.imageCount} extracted image${artifact.imageCount === 1 ? '' : 's'} for download…`, 'neutral');
      const headers = new Headers({
        'Content-Type': artifact.contentType,
        'X-PDF-Artifact-Filename': encodeHeader(artifact.filename),
        'X-PDF-Source-Filename': encodeHeader(file.name),
        'X-PDF-Image-Count': String(artifact.imageCount)
      });
      if (artifact.requestedJson) headers.set('X-PDF-Requested-Json', encodeHeader(artifact.requestedJson));

      const response = await fetch('/api/pdf-extractions', {
        method: 'POST',
        headers,
        body: artifact.blob
      });
      const result = await readJsonResponse(response);
      if (!response.ok) throw new Error(result.error || `Extraction failed with status ${response.status}.`);
      if (!result.downloadUrl) throw new Error('The extraction finished without a download URL.');

      state.downloadUrl = result.downloadUrl;
      state.downloadFilename = result.filename || artifact.filename;
      elements.actionButton.querySelector('.button-label').textContent = 'Download';
      elements.actionButton.disabled = false;
      setStatus(`${result.imageCount} image${result.imageCount === 1 ? '' : 's'} extracted. Select Download to save ${state.downloadFilename}.`, 'success');
    } catch (error) {
      resetDownload();
      setStatus(error.message || 'Image extraction failed.', 'error');
    } finally {
      setLoading(false);
    }
  }

  function resetDownload() {
    state.downloadUrl = '';
    state.downloadFilename = '';
    elements.actionButton.querySelector('.button-label').textContent = 'Extract';
    elements.actionButton.disabled = false;
  }

  function setLoading(loading) {
    elements.actionButton.classList.toggle('is-loading', loading);
    elements.actionButton.setAttribute('aria-busy', String(loading));
    elements.actionButton.disabled = loading;
    const label = elements.actionButton.querySelector('.button-label');
    if (loading) label.textContent = 'Extracting…';
    else if (!state.downloadUrl) label.textContent = 'Extract';
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
      const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
      return { error: title || `Cloudflare returned an unexpected response (status ${response.status}).` };
    }
  }

  function encodeHeader(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
})();

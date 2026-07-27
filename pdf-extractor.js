'use strict';

(() => {
  const MAX_PDF_BYTES = 25 * 1024 * 1024;
  const elements = {
    fileInput: document.querySelector('#pdf-file-input'),
    dropZone: document.querySelector('#pdf-drop-zone'),
    selectedFileName: document.querySelector('#pdf-selected-file-name'),
    selectors: document.querySelector('#pdf-images-json'),
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
  elements.selectors.addEventListener('input', resetDownload);
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
    setStatus(`Selected ${file.name}. Leave the JSON box empty to extract every embedded image.`, 'neutral');
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

    let requestedJson = '';
    const rawSelectors = elements.selectors.value.trim();
    if (rawSelectors) {
      try {
        const parsed = JSON.parse(rawSelectors);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The value must be a JSON object.');
        requestedJson = JSON.stringify(parsed);
      } catch (error) {
        return setStatus(`Invalid image selection JSON: ${error.message}`, 'error');
      }
    }

    const form = new FormData();
    form.append('pdf', file, file.name);
    if (requestedJson) form.append('images', requestedJson);

    setLoading(true);
    setStatus('Reading the PDF and extracting its embedded images…', 'neutral');
    try {
      const response = await fetch('/api/pdf-extractions', { method: 'POST', body: form });
      const result = await readJsonResponse(response);
      if (!response.ok) throw new Error(result.error || `Extraction failed with status ${response.status}.`);
      if (!result.downloadUrl) throw new Error('The extraction finished without a download URL.');

      state.downloadUrl = result.downloadUrl;
      state.downloadFilename = result.filename || '';
      elements.actionButton.querySelector('.button-label').textContent = 'Download';
      elements.actionButton.disabled = false;
      setStatus(`${result.imageCount} image${result.imageCount === 1 ? '' : 's'} extracted. Select Download to save ${result.filename || 'the result'}.`, 'success');
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
    try { return JSON.parse(text); }
    catch { return { error: text.trim().slice(0, 300) || `Request failed with status ${response.status}.` }; }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
})();

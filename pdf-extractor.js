'use strict';

(() => {
  const MAX_PDF_BYTES = 25 * 1024 * 1024;
  const MAX_RESULT_BYTES = 64 * 1024 * 1024;
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

    setLoading(true);
    try {
      setStatus('Loading the PDF engine in your browser…', 'neutral');
      const { extractPdfArtifact } = await import('/pdf-extractor-runtime.js?v=device-images-1');

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

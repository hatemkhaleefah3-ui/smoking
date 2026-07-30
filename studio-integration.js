'use strict';

(() => {
  const fileInput = document.querySelector('#file-input');
  const dropZone = document.querySelector('#drop-zone');
  const buildButton = document.querySelector('#build-button');
  const status = document.querySelector('#status');
  const documentDetails = document.querySelector('#document-details');
  const imageImportList = document.querySelector('#image-import-list');
  const imageImportSummary = document.querySelector('#image-import-summary');
  const publishedLink = document.querySelector('#published-link');
  const summaryWordCount = document.querySelector('#summary-word-count');
  const summaryImageCount = document.querySelector('#summary-image-count');
  const summaryFileSize = document.querySelector('#summary-file-size');
  let activeJsonFile = null;
  let lastBuildKey = '';
  let lastPublishedUrl = '';

  fileInput?.addEventListener('change', () => {
    activeJsonFile = fileInput.files?.[0] || null;
    queueAutomaticBuild();
  });

  dropZone?.addEventListener('drop', (event) => {
    activeJsonFile = event.dataTransfer?.files?.[0] || null;
    queueAutomaticBuild();
  });

  const statusObserver = new MutationObserver(() => inspectBuildStatus());
  if (status) statusObserver.observe(status, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  const imageObserver = new MutationObserver(() => reportImageProgress());
  if (imageImportList) imageObserver.observe(imageImportList, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ready'] });
  if (imageImportSummary) imageObserver.observe(imageImportSummary, { childList: true, characterData: true, subtree: true });

  const publicationObserver = new MutationObserver(() => inspectPublication());
  if (publishedLink) publicationObserver.observe(publishedLink, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'href'] });

  function queueAutomaticBuild() {
    lastBuildKey = '';
    lastPublishedUrl = '';
    window.setTimeout(() => {
      if (activeJsonFile && buildButton && !buildButton.disabled) buildButton.click();
    }, 0);
  }

  async function inspectBuildStatus() {
    if (!status) return;
    const message = status.textContent?.trim() || '';
    if (status.classList.contains('status-error') && /^Build failed:/i.test(message)) {
      window.dispatchEvent(new CustomEvent('lecture:build-failed', { detail: { message } }));
      return;
    }
    if (!status.classList.contains('status-success') || !/^Built .+ successfully\./i.test(message) || documentDetails?.hidden) return;

    const key = activeJsonFile ? `${activeJsonFile.name}:${activeJsonFile.size}:${activeJsonFile.lastModified}` : message;
    if (key === lastBuildKey) return;
    lastBuildKey = key;

    const metrics = await calculateMetrics(activeJsonFile);
    const imageCount = imageImportList?.querySelectorAll('.image-import-item').length || metrics.imageCount;
    if (summaryWordCount) summaryWordCount.textContent = formatNumber(metrics.wordCount);
    if (summaryImageCount) summaryImageCount.textContent = formatNumber(imageCount);
    if (summaryFileSize) summaryFileSize.textContent = activeJsonFile ? formatBytes(activeJsonFile.size) : formatBytes(metrics.byteSize);

    window.dispatchEvent(new CustomEvent('lecture:built', {
      detail: {
        imageCount,
        wordCount: metrics.wordCount,
        byteSize: activeJsonFile?.size || metrics.byteSize,
        fileName: activeJsonFile?.name || ''
      }
    }));
    reportImageProgress();
  }

  function reportImageProgress() {
    const cards = [...(imageImportList?.querySelectorAll('.image-import-item') || [])];
    if (!cards.length) return;
    const ready = cards.filter((card) => card.dataset.ready === 'true').length;
    window.dispatchEvent(new CustomEvent('lecture:images-updated', { detail: { ready, total: cards.length } }));
  }

  function inspectPublication() {
    const url = publishedLink?.href || '';
    if (!url || publishedLink?.hidden || url === lastPublishedUrl) return;
    lastPublishedUrl = url;
    window.dispatchEvent(new CustomEvent('lecture:published', { detail: { url } }));
  }

  async function calculateMetrics(file) {
    if (!file) return { wordCount: 0, imageCount: 0, byteSize: 0 };
    try {
      const text = await file.text();
      const cleaned = window.LectureRenderer?.stripOptionalCodeFence
        ? window.LectureRenderer.stripOptionalCodeFence(text)
        : text;
      const source = JSON.parse(cleaned);
      return {
        wordCount: countWords(source),
        imageCount: Array.isArray(source?.imoo?.images) ? source.imoo.images.length : 0,
        byteSize: new Blob([text]).size
      };
    } catch {
      return { wordCount: 0, imageCount: 0, byteSize: file.size || 0 };
    }
  }

  function countWords(value, key = '') {
    if (typeof value === 'string') {
      if (/^(?:src|url|href|licenseUrl|creatorUrl|sourcePage|id)$/i.test(key)) return 0;
      return (value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
    }
    if (Array.isArray(value)) return value.reduce((total, item) => total + countWords(item, key), 0);
    if (value && typeof value === 'object') {
      return Object.entries(value).reduce((total, [childKey, child]) => total + countWords(child, childKey), 0);
    }
    return 0;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Math.max(0, Number(value) || 0));
  }

  function formatBytes(bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 ** 2).toFixed(1)} MB`;
  }
})();

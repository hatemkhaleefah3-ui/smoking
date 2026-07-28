'use strict';

const mediaSearchForm = document.querySelector('#media-search-form');
const mediaSearchInput = document.querySelector('#media-search-input');
const mediaSearchButton = document.querySelector('#media-search-button');
const mediaSearchStatus = document.querySelector('#media-search-status');
const mediaSearchResults = document.querySelector('#media-search-results');

mediaSearchForm?.addEventListener('submit', searchMedia);

async function searchMedia(event) {
  event.preventDefault();
  const query = mediaSearchInput.value.trim();
  clearMediaResults();

  if (!query) {
    setMediaStatus('Enter a search term first.', 'error');
    mediaSearchInput.focus();
    return;
  }

  setMediaLoading(true);
  setMediaStatus('Finding relevant images…', 'neutral');

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || 'Search failed.');

    const images = Array.isArray(result.images) ? result.images.filter((value) => typeof value === 'string') : [];
    if (images.length === 0) {
      setMediaStatus('No images found', 'neutral');
      return;
    }

    renderMediaResults(images, query);
    setMediaStatus(`Found ${images.length} image${images.length === 1 ? '' : 's'}.`, 'success');
  } catch {
    setMediaStatus('Something went wrong', 'error');
  } finally {
    setMediaLoading(false);
  }
}

function renderMediaResults(images, query) {
  const fragment = document.createDocumentFragment();
  images.slice(0, 5).forEach((url) => {
    const link = document.createElement('a');
    link.className = 'media-result-card';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    const image = document.createElement('img');
    image.src = url;
    image.alt = query;
    image.loading = 'lazy';
    image.decoding = 'async';
    link.append(image);
    fragment.append(link);
  });
  mediaSearchResults.append(fragment);
  mediaSearchResults.hidden = false;
}

function clearMediaResults() {
  mediaSearchResults.replaceChildren();
  mediaSearchResults.hidden = true;
}

function setMediaLoading(loading) {
  mediaSearchButton.disabled = loading;
  mediaSearchInput.disabled = loading;
  mediaSearchForm.setAttribute('aria-busy', String(loading));
  mediaSearchButton.textContent = loading ? 'Searching…' : 'Search';
}

function setMediaStatus(message, type) {
  mediaSearchStatus.textContent = message;
  mediaSearchStatus.className = `status status-${type}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return {}; }
}

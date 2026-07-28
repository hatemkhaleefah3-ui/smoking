'use strict';

(() => {
  const elements = {
    jsonInput: document.querySelector('#file-input'),
    jsonDropZone: document.querySelector('#drop-zone'),
    buildButton: document.querySelector('#build-button'),
    imageList: document.querySelector('#image-import-list'),
    status: document.querySelector('#status')
  };
  if (Object.values(elements).some((element) => !element) || !window.ImageImportWorkflow) return;

  const state = {
    definitions: [],
    slots: [],
    cards: new Map(),
    readSequence: 0,
    renderQueued: false
  };

  elements.jsonInput.addEventListener('change', () => {
    const file = elements.jsonInput.files?.[0];
    if (file) readJson(file);
    else reset();
  });
  elements.jsonDropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) readJson(file);
  });
  elements.buildButton.addEventListener('click', () => queueRender(true));
  elements.imageList.addEventListener('change', captureNativeSelection, true);
  new MutationObserver(() => queueRender(false)).observe(elements.imageList, { childList: true, subtree: true });

  async function readJson(file) {
    const sequence = ++state.readSequence;
    reset(false);
    try {
      const raw = await file.text();
      if (sequence !== state.readSequence) return;
      const text = window.LectureRenderer?.stripOptionalCodeFence
        ? window.LectureRenderer.stripOptionalCodeFence(raw)
        : raw;
      const source = JSON.parse(text);
      if (!source?.imoo || !Array.isArray(source.imoo.images)) return;
      state.slots = window.ImageImportWorkflow.collectImageSlots(source);
      state.definitions = source.imoo.images.map((item) => ({
        id: typeof item?.id === 'string' ? item.id.trim() : '',
        altTexts: collectAltTexts(item)
      })).filter((item) => item.id);
      state.definitions.forEach((definition) => ensureCardState(definition.id));
      queueRender(true);
    } catch {
      reset();
    }
  }

  function collectAltTexts(item) {
    const values = [];
    if (typeof item?.altText === 'string') values.push(item.altText);
    if (Array.isArray(item?.altTexts)) values.push(...item.altTexts);
    if (Array.isArray(item?.descriptions)) values.push(...item.descriptions);
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 5);
  }

  function ensureCardState(id) {
    if (!state.cards.has(id)) {
      state.cards.set(id, {
        id,
        candidates: [],
        selectedKey: '',
        searching: false,
        searched: false,
        error: ''
      });
    }
    return state.cards.get(id);
  }

  function reset(increment = true) {
    if (increment) state.readSequence += 1;
    for (const card of state.cards.values()) revokeCandidates(card.candidates);
    state.definitions = [];
    state.slots = [];
    state.cards.clear();
    elements.imageList.querySelectorAll('.image-candidate-shell').forEach((node) => node.remove());
  }

  function queueRender(startSearch) {
    if (state.renderQueued) return;
    state.renderQueued = true;
    queueMicrotask(() => {
      state.renderQueued = false;
      render(startSearch);
    });
  }

  function render(startSearch) {
    if (!state.definitions.length) return;
    const imageCards = [...elements.imageList.querySelectorAll('.image-import-item')];
    if (!imageCards.length || imageCards.length !== state.slots.length) return;

    const slotIndex = new Map();
    state.slots.forEach((slot, index) => { if (slot.sourceId) slotIndex.set(slot.sourceId, index); });

    for (const definition of state.definitions) {
      const index = slotIndex.get(definition.id);
      if (!Number.isInteger(index)) continue;
      const cardElement = imageCards[index];
      let shell = cardElement.querySelector('.image-candidate-shell');
      if (!shell) {
        shell = document.createElement('section');
        shell.className = 'image-candidate-shell';
        cardElement.append(shell);
      }
      renderCarousel(shell, definition, index);
      const cardState = ensureCardState(definition.id);
      if (startSearch && !cardState.searched && !cardState.searching) searchDefinition(definition);
    }
  }

  function renderCarousel(shell, definition, slotIndex) {
    const cardState = ensureCardState(definition.id);
    shell.replaceChildren();

    const header = document.createElement('div');
    header.className = 'image-candidate-header';
    const title = document.createElement('strong');
    title.textContent = 'Image choices';
    const status = document.createElement('small');
    status.textContent = cardState.searching
      ? 'Searching Wikimedia…'
      : cardState.error || `${cardState.candidates.length} choice${cardState.candidates.length === 1 ? '' : 's'}`;
    header.append(title, status);

    const viewport = document.createElement('div');
    viewport.className = 'image-candidate-viewport';
    viewport.setAttribute('role', 'listbox');
    viewport.setAttribute('aria-label', `Image choices for ${definition.id}`);

    if (!cardState.candidates.length) {
      const empty = document.createElement('p');
      empty.className = 'image-candidate-empty';
      empty.textContent = cardState.searching ? 'Finding reusable Wikimedia images…' : 'PDF, Wikimedia, or added images will appear here.';
      viewport.append(empty);
    } else {
      for (const candidate of cardState.candidates) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'image-candidate-slide';
        button.dataset.selected = String(candidate.key === cardState.selectedKey);
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(candidate.key === cardState.selectedKey));
        button.title = candidate.label;
        const image = document.createElement('img');
        image.src = candidate.previewUrl;
        image.alt = candidate.label;
        image.loading = 'lazy';
        const badge = document.createElement('span');
        badge.textContent = candidate.source;
        button.append(image, badge);
        button.addEventListener('click', () => selectCandidate(definition.id, candidate.key, slotIndex));
        viewport.append(button);
      }
    }

    const controls = document.createElement('div');
    controls.className = 'image-candidate-actions';
    controls.append(
      actionButton('Save', () => saveSelected(definition.id)),
      actionButton('Delete', () => deleteSelected(definition.id, slotIndex)),
      addButton(definition.id, slotIndex)
    );

    shell.append(header, viewport, controls);
  }

  function actionButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-secondary image-candidate-action';
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  function addButton(id, slotIndex) {
    const wrap = document.createElement('label');
    wrap.className = 'button button-secondary image-candidate-action';
    wrap.textContent = 'Add';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = [...window.ImageImportWorkflow.ACCEPTED_IMAGE_TYPES].join(',');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const error = window.ImageImportWorkflow.validateImageFile(file);
      if (error) return setMainStatus(error, 'error');
      addFileCandidate(id, file, 'Added', true);
      selectCandidate(id, `file:${file.name}:${file.size}:${file.lastModified}`, slotIndex);
    });
    wrap.append(input);
    return wrap;
  }

  async function searchDefinition(definition) {
    const cardState = ensureCardState(definition.id);
    cardState.searching = true;
    cardState.error = '';
    queueRender(false);
    const seen = new Set(cardState.candidates.map((candidate) => candidate.remoteUrl).filter(Boolean));
    try {
      for (const altText of definition.altTexts) {
        const response = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: altText })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) continue;
        for (const url of result.images || []) {
          if (typeof url !== 'string' || seen.has(url)) continue;
          seen.add(url);
          cardState.candidates.push({
            key: `wikimedia:${url}`,
            source: 'Wikimedia',
            label: altText,
            previewUrl: url,
            remoteUrl: url,
            file: null,
            revoke: false
          });
        }
      }
      cardState.searched = true;
      if (!cardState.candidates.length) cardState.error = 'No Wikimedia images found.';
      if (!cardState.selectedKey && cardState.candidates.length) {
        const index = slotIndexForId(definition.id);
        if (Number.isInteger(index)) await selectCandidate(definition.id, cardState.candidates[0].key, index);
      }
    } catch {
      cardState.error = 'Wikimedia search could not finish.';
    } finally {
      cardState.searching = false;
      queueRender(false);
    }
  }

  function captureNativeSelection(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.closest('.image-candidate-shell')) return;
    const cardElement = input.closest('.image-import-item');
    if (!cardElement) return;
    const cards = [...elements.imageList.querySelectorAll('.image-import-item')];
    const index = cards.indexOf(cardElement);
    const slot = state.slots[index];
    const file = input.files?.[0];
    if (!slot?.sourceId || !file || !state.cards.has(slot.sourceId)) return;
    addFileCandidate(slot.sourceId, file, 'PDF / local', true);
    queueRender(false);
  }

  function addFileCandidate(id, file, source, select) {
    const cardState = ensureCardState(id);
    const key = `file:${file.name}:${file.size}:${file.lastModified}`;
    const existing = cardState.candidates.find((candidate) => candidate.key === key);
    if (!existing) {
      const previewUrl = URL.createObjectURL(file);
      cardState.candidates.unshift({ key, source, label: file.name, previewUrl, file, revoke: true });
    }
    if (select) cardState.selectedKey = key;
    return key;
  }

  async function selectCandidate(id, key, slotIndex) {
    const cardState = ensureCardState(id);
    const candidate = cardState.candidates.find((item) => item.key === key);
    if (!candidate) return;
    try {
      let file = candidate.file;
      if (!file && candidate.remoteUrl) {
        setMainStatus(`Importing Wikimedia image for “${id}”…`, 'neutral');
        const response = await fetch(candidate.remoteUrl, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error(`Wikimedia image returned ${response.status}.`);
        const blob = await response.blob();
        const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
        file = new File([blob], `${safeFilename(id)}.${extensionFor(type)}`, { type, lastModified: Date.now() });
        const error = window.ImageImportWorkflow.validateImageFile(file);
        if (error) throw new Error(error);
        candidate.file = file;
      }
      fillNativeInput(slotIndex, file);
      cardState.selectedKey = key;
      queueRender(false);
      setMainStatus(`Selected ${candidate.source} image for “${id}”.`, 'success');
    } catch (error) {
      setMainStatus(error instanceof Error ? error.message : 'Could not select this image.', 'error');
    }
  }

  function fillNativeInput(slotIndex, file) {
    if (!(file instanceof File) || typeof DataTransfer !== 'function') throw new Error('This browser cannot import the selected image automatically.');
    const inputs = [...elements.imageList.querySelectorAll('.image-import-item > .image-import-controls input[type="file"]')];
    const input = inputs[slotIndex];
    if (!input) throw new Error('The destination image button is unavailable.');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function deleteSelected(id, slotIndex) {
    const cardState = ensureCardState(id);
    const index = cardState.candidates.findIndex((candidate) => candidate.key === cardState.selectedKey);
    if (index < 0) return;
    const [removed] = cardState.candidates.splice(index, 1);
    if (removed.revoke) URL.revokeObjectURL(removed.previewUrl);
    cardState.selectedKey = '';
    clearNativeInput(slotIndex);
    const next = cardState.candidates[Math.min(index, cardState.candidates.length - 1)];
    if (next) selectCandidate(id, next.key, slotIndex);
    else queueRender(false);
  }

  function clearNativeInput(slotIndex) {
    const inputs = [...elements.imageList.querySelectorAll('.image-import-item > .image-import-controls input[type="file"]')];
    const input = inputs[slotIndex];
    if (!input || typeof DataTransfer !== 'function') return;
    input.files = new DataTransfer().files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function saveSelected(id) {
    const cardState = ensureCardState(id);
    const candidate = cardState.candidates.find((item) => item.key === cardState.selectedKey);
    if (!candidate) return setMainStatus('Select an image before saving it.', 'error');
    try {
      const blob = candidate.file || await fetch(candidate.remoteUrl, { mode: 'cors', credentials: 'omit' }).then((response) => {
        if (!response.ok) throw new Error(`Image returned ${response.status}.`);
        return response.blob();
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = candidate.file?.name || `${safeFilename(id)}.${extensionFor(blob.type)}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setMainStatus(error instanceof Error ? error.message : 'Could not save this image.', 'error');
    }
  }

  function slotIndexForId(id) {
    return state.slots.findIndex((slot) => slot.sourceId === id);
  }

  function revokeCandidates(candidates) {
    for (const candidate of candidates || []) if (candidate.revoke) URL.revokeObjectURL(candidate.previewUrl);
  }

  function setMainStatus(message, type) {
    elements.status.textContent = message;
    elements.status.className = `status status-${type}`;
  }

  function safeFilename(value) {
    return String(value || 'image').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'image';
  }

  function extensionFor(type) {
    return ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[type] || 'jpg';
  }
})();

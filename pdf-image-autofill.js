'use strict';

(() => {
  const elements = {
    jsonInput: document.querySelector('#file-input'),
    jsonDropZone: document.querySelector('#drop-zone'),
    buildButton: document.querySelector('#build-button'),
    imagePanel: document.querySelector('#image-import-panel'),
    imageList: document.querySelector('#image-import-list'),
    host: document.querySelector('#pdf-image-import-assistant'),
    mainStatus: document.querySelector('#status')
  };

  if (Object.values(elements).some((element) => !element) || !window.ImageImportWorkflow) return;

  const state = {
    sourceData: null,
    slots: [],
    plan: null,
    busy: false,
    statusMessage: '',
    statusType: 'neutral',
    selectedFilename: '',
    readSequence: 0
  };

  elements.jsonInput.addEventListener('change', () => {
    const file = elements.jsonInput.files?.[0];
    if (file) readLectureJson(file);
    else resetAssistant();
  });

  elements.jsonDropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) readLectureJson(file);
  });

  elements.buildButton.addEventListener('click', () => queueMicrotask(renderAssistant));

  const observer = new MutationObserver(renderAssistant);
  observer.observe(elements.imageList, { childList: true, subtree: true });

  async function readLectureJson(file) {
    const sequence = ++state.readSequence;
    state.sourceData = null;
    state.slots = [];
    state.plan = null;
    state.statusMessage = '';
    state.statusType = 'neutral';
    state.selectedFilename = '';
    renderAssistant();

    try {
      const text = await file.text();
      if (sequence !== state.readSequence) return;
      const stripped = window.LectureRenderer?.stripOptionalCodeFence
        ? window.LectureRenderer.stripOptionalCodeFence(text)
        : text;
      const sourceData = JSON.parse(stripped);
      const slots = window.ImageImportWorkflow.collectImageSlots(sourceData);
      state.sourceData = sourceData;
      state.slots = slots;
      state.plan = window.ImageImportWorkflow.collectPdfImportPlan(sourceData, slots);
      renderAssistant();
    } catch {
      if (sequence !== state.readSequence) return;
      resetAssistant();
    }
  }

  function resetAssistant() {
    state.readSequence += 1;
    state.sourceData = null;
    state.slots = [];
    state.plan = null;
    state.busy = false;
    state.statusMessage = '';
    state.statusType = 'neutral';
    state.selectedFilename = '';
    elements.host.hidden = true;
    elements.host.replaceChildren();
  }

  function renderAssistant() {
    const plan = state.plan;
    elements.host.replaceChildren();

    if (!plan) {
      elements.host.hidden = true;
      return;
    }

    elements.host.hidden = false;
    const card = document.createElement('section');
    card.className = 'pdf-autofill-card';
    card.setAttribute('aria-labelledby', 'pdf-autofill-title');

    const heading = document.createElement('div');
    heading.className = 'pdf-autofill-heading';
    const titleGroup = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'pdf-autofill-eyebrow';
    eyebrow.textContent = 'Optional automatic import';
    const title = document.createElement('h3');
    title.id = 'pdf-autofill-title';
    title.textContent = 'Extract labeled images from the lecture file';
    titleGroup.append(eyebrow, title);
    const badge = document.createElement('span');
    badge.className = 'pdf-autofill-type';
    badge.textContent = plan.fileTypeLabel;
    heading.append(titleGroup, badge);

    const description = document.createElement('p');
    description.className = 'pdf-autofill-description';
    description.textContent = plan.errors.length
      ? 'The imoo configuration must be corrected before automatic PDF import can run.'
      : `Import the exact lecture file. The website will extract ${plan.images.length} specified image${plan.images.length === 1 ? '' : 's'} and place each one into the image button with the same id.`;

    const fileRow = document.createElement('div');
    fileRow.className = 'pdf-autofill-file-row';
    const fileCopy = document.createElement('div');
    fileCopy.className = 'pdf-autofill-file-copy';
    const label = document.createElement('strong');
    label.textContent = plan.lectureLabel;
    const expected = document.createElement('small');
    expected.textContent = plan.lectureName
      ? `Required filename: ${plan.lectureName}`
      : 'lectureName is missing from the JSON';
    fileCopy.append(label, expected);

    const inputId = 'pdf-autofill-input';
    const choose = document.createElement('label');
    choose.className = 'image-file-button pdf-autofill-button';
    choose.htmlFor = inputId;
    choose.textContent = state.busy ? 'Extracting…' : state.selectedFilename ? 'Choose again' : `Import ${plan.fileTypeLabel}`;
    const input = document.createElement('input');
    input.id = inputId;
    input.className = 'pdf-autofill-input';
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.disabled = state.busy || plan.errors.length > 0;
    input.setAttribute('aria-label', `Import the exact lecture file ${plan.lectureName || ''}`.trim());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) handleLecturePdf(file);
    });
    fileRow.append(fileCopy, choose, input);

    card.append(heading, description, fileRow);

    if (plan.errors.length) {
      const errorList = document.createElement('ul');
      errorList.className = 'pdf-autofill-errors';
      plan.errors.forEach((message) => {
        const item = document.createElement('li');
        item.textContent = message;
        errorList.append(item);
      });
      card.append(errorList);
    } else {
      const mapping = document.createElement('p');
      mapping.className = 'pdf-autofill-mapping';
      mapping.textContent = `${plan.images.length} imoo location${plan.images.length === 1 ? '' : 's'} mapped to ${plan.images.length} image id${plan.images.length === 1 ? '' : 's'}. Manual image selection remains available for replacement.`;
      card.append(mapping);
    }

    const status = document.createElement('div');
    status.className = `pdf-autofill-status status-${state.statusType}`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = state.statusMessage || defaultStatus(plan);
    card.append(status);

    elements.host.append(card);
  }

  function defaultStatus(plan) {
    if (plan.errors.length) return 'Automatic PDF import is unavailable until the listed JSON errors are fixed.';
    if (state.selectedFilename) return `Selected ${state.selectedFilename}.`;
    return `Choose ${plan.lectureName} after selecting Build.`;
  }

  async function handleLecturePdf(file) {
    const plan = state.plan;
    if (!plan || plan.errors.length) return;

    const validationError = window.ImageImportWorkflow.validateLecturePdfFile(file, plan);
    if (validationError) {
      setAssistantStatus(validationError, 'error');
      return;
    }

    state.busy = true;
    state.selectedFilename = file.name;
    setAssistantStatus(`Verifying ${file.name}…`, 'neutral', false);

    try {
      const header = new TextDecoder('ascii').decode(await file.slice(0, 1024).arrayBuffer());
      if (!header.includes('%PDF-')) throw new Error('The selected file does not contain a valid PDF header.');

      const imageCards = elements.imageList.querySelectorAll('.image-import-item');
      if (imageCards.length !== state.slots.length) {
        throw new Error('Select Build before importing the lecture PDF.');
      }
      if (typeof DataTransfer !== 'function') {
        throw new Error('This browser cannot automatically fill file controls. Use the manual image buttons instead.');
      }

      setAssistantStatus(`Extracting ${plan.images.length} requested image${plan.images.length === 1 ? '' : 's'} from ${file.name}…`, 'neutral', false);
      const runtime = await import('/pdf-extractor-runtime.js?v=imoo-autofill-1');
      if (typeof runtime.extractPdfImages !== 'function') throw new Error('The PDF image runtime is not up to date.');
      const selectors = plan.images.map(({ page, position }) => ({ page, position }));
      const extracted = await runtime.extractPdfImages(file, selectors);
      const byLocation = new Map(extracted.map((item) => [`${item.page}:${item.position}`, item]));
      const slotIndexById = new Map();
      state.slots.forEach((slot, index) => {
        if (slot.sourceId) slotIndexById.set(slot.sourceId, index);
      });

      const assignments = plan.images.map((definition) => {
        const extractedImage = byLocation.get(`${definition.page}:${definition.position}`);
        if (!extractedImage) {
          throw new Error(`No image was extracted for ${definition.id} at page ${definition.page}, position ${definition.position}.`);
        }
        const slotIndex = slotIndexById.get(definition.id);
        if (!Number.isInteger(slotIndex)) throw new Error(`No image button matches id “${definition.id}”.`);
        const imageFile = new File(
          [extractedImage.blob || extractedImage.bytes],
          `${safeFilename(definition.id)}.png`,
          { type: 'image/png', lastModified: Date.now() }
        );
        const imageError = window.ImageImportWorkflow.validateImageFile(imageFile);
        if (imageError) throw new Error(`${definition.id}: ${imageError}`);
        return { definition, slotIndex, imageFile };
      });

      for (let index = 0; index < assignments.length; index += 1) {
        const assignment = assignments[index];
        setAssistantStatus(`Importing ${assignment.definition.id} (${index + 1} of ${assignments.length})…`, 'neutral', false);
        const inputs = [...elements.imageList.querySelectorAll('.image-import-item input[type="file"]')];
        const destination = inputs[assignment.slotIndex];
        if (!destination) throw new Error(`The image button for “${assignment.definition.id}” is no longer available.`);
        const transfer = new DataTransfer();
        transfer.items.add(assignment.imageFile);
        destination.files = transfer.files;
        destination.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const message = `${assignments.length} image${assignments.length === 1 ? '' : 's'} extracted from ${file.name} and placed into their matching image buttons.`;
      setAssistantStatus(`${message} You can replace any image manually before selecting Continue.`, 'success', false);
      setMainStatus(message, 'success');
    } catch (error) {
      setAssistantStatus(error instanceof Error ? error.message : 'Could not extract the requested PDF images.', 'error', false);
    } finally {
      state.busy = false;
      renderAssistant();
    }
  }

  function setAssistantStatus(message, type, render = true) {
    state.statusMessage = message;
    state.statusType = type;
    if (render) renderAssistant();
    else {
      const status = elements.host.querySelector('.pdf-autofill-status');
      if (status) {
        status.className = `pdf-autofill-status status-${type}`;
        status.textContent = message;
      }
    }
  }

  function setMainStatus(message, type) {
    elements.mainStatus.textContent = message;
    elements.mainStatus.className = `status status-${type}`;
  }

  function safeFilename(value) {
    const safe = String(value || 'image').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
    return safe || 'image';
  }
})();

'use strict';

(function exposeImageImportWorkflow(global) {
  const ACCEPTED_IMAGE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif'
  ]);
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_LECTURE_PDF_BYTES = 25 * 1024 * 1024;

  function collectImageSlots(source) {
    const sections = source?.document?.sections;
    if (!Array.isArray(sections)) return [];
    const slots = [];
    visit(sections, ['document', 'sections'], '', slots);
    return slots.map((slot, index) => ({ ...slot, id: `image-slot-${index + 1}` }));
  }

  function visit(value, path, sectionTitle, slots) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index], sectionTitle, slots));
      return;
    }
    if (!isObject(value)) return;

    const currentSectionTitle = typeof value.title === 'string' && Array.isArray(value.blocks)
      ? value.title.trim()
      : sectionTitle;

    if (value.type === 'image') {
      const sourceId = typeof value.id === 'string' ? value.id.trim() : '';
      const label = firstText(value.label, value.altText, value.caption, value.title, sourceId)
        || `Image ${slots.length + 1}`;
      const existingSrc = usableImageSource(value.src);
      slots.push({
        path,
        pathKey: pathKey(path),
        sourceId,
        label,
        sectionTitle: currentSectionTitle,
        existingSrc,
        required: !existingSrc
      });
      return;
    }

    Object.entries(value).forEach(([key, child]) => {
      if (child && typeof child === 'object') visit(child, [...path, key], currentSectionTitle, slots);
    });
  }

  function collectPdfImportPlan(source, slots = collectImageSlots(source)) {
    const lectureName = typeof source?.lectureName === 'string' ? source.lectureName.trim() : '';
    const rawImages = source?.imoo?.images;
    const hasImoo = Array.isArray(rawImages) || isObject(source?.imoo);
    if (!lectureName && !hasImoo) return null;

    const errors = [];
    const extensionMatch = lectureName.match(/\.([^.]+)$/);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : '';
    const lectureLabel = lectureName && extensionMatch
      ? lectureName.slice(0, -(extension.length + 1))
      : lectureName;

    if (!lectureName) errors.push('The JSON must include a top-level lectureName for PDF auto-import.');
    if (lectureName && extension !== 'pdf') errors.push('lectureName must end with .pdf for PDF image extraction.');
    if (!Array.isArray(rawImages) || rawImages.length === 0) {
      errors.push('imoo.images must be a non-empty array.');
    }

    const slotCounts = new Map();
    for (const slot of slots || []) {
      if (!slot?.sourceId) continue;
      slotCounts.set(slot.sourceId, (slotCounts.get(slot.sourceId) || 0) + 1);
    }

    const images = [];
    const seenIds = new Set();
    if (Array.isArray(rawImages)) {
      rawImages.forEach((item, index) => {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        const page = Number(item?.page);
        const position = Number(item?.position);
        const altText = typeof item?.altText === 'string' ? item.altText.trim() : '';
        const prefix = `imoo.images[${index}]`;

        if (!id) errors.push(`${prefix}.id must be a non-empty string.`);
        if (id && seenIds.has(id)) errors.push(`${prefix}.id duplicates “${id}”.`);
        if (id) seenIds.add(id);
        if (!Number.isSafeInteger(page) || page < 1) errors.push(`${prefix}.page must be a positive integer.`);
        if (!Number.isSafeInteger(position) || position < 1) errors.push(`${prefix}.position must be a positive integer.`);

        if (id) {
          const matches = slotCounts.get(id) || 0;
          if (matches === 0) errors.push(`${prefix}.id “${id}” does not match any image block id.`);
          if (matches > 1) errors.push(`${prefix}.id “${id}” matches more than one image block.`);
        }

        if (id && Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(position) && position > 0) {
          images.push({ id, page, position, altText });
        }
      });
    }

    return {
      lectureName,
      lectureLabel: lectureLabel || 'Lecture source',
      extension,
      fileTypeLabel: extension ? extension.toUpperCase() : 'PDF',
      mimeType: 'application/pdf',
      images,
      errors,
      available: errors.length === 0
    };
  }

  function validateLecturePdfFile(file, plan) {
    if (!file || typeof file !== 'object') return 'Choose the lecture PDF file.';
    if (!plan?.lectureName) return 'The imported JSON does not define lectureName.';
    const actualName = normalizeFilename(file.name);
    const expectedName = normalizeFilename(plan.lectureName);
    if (actualName !== expectedName) return `Choose the exact file named “${plan.lectureName}”.`;
    const type = String(file.type || '').toLowerCase();
    if (type && type !== plan.mimeType) return `The selected file must be ${plan.fileTypeLabel}.`;
    if (!Number.isFinite(file.size) || file.size <= 0) return 'The selected lecture file is empty.';
    if (file.size > MAX_LECTURE_PDF_BYTES) return 'The lecture PDF must be 25 MB or smaller.';
    return '';
  }

  function applyImageSources(source, assignments) {
    const clone = deepClone(source);
    for (const assignment of assignments || []) {
      if (!assignment || !Array.isArray(assignment.path)) continue;
      const src = typeof assignment.src === 'string' ? assignment.src.trim() : '';
      if (!src) continue;
      const block = valueAtPath(clone, assignment.path);
      if (isObject(block) && block.type === 'image') block.src = src;
    }
    return clone;
  }

  function validateImageFile(file) {
    if (!file || typeof file !== 'object') return 'Choose an image file.';
    if (!ACCEPTED_IMAGE_TYPES.has(String(file.type || '').toLowerCase())) {
      return 'Use a JPEG, PNG, WebP, GIF or AVIF image.';
    }
    if (!Number.isFinite(file.size) || file.size <= 0) return 'The selected image is empty.';
    if (file.size > MAX_IMAGE_BYTES) return 'Each image must be 8 MB or smaller.';
    return '';
  }

  function valueAtPath(root, path) {
    let value = root;
    for (const segment of path) {
      if (value == null) return undefined;
      value = value[segment];
    }
    return value;
  }

  function pathKey(path) {
    return path.map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
  }

  function usableImageSource(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^(?:https?:\/\/|\/)/i.test(text) ? text : '';
  }

  function firstText(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function normalizeFilename(value) {
    const text = String(value || '');
    return typeof text.normalize === 'function' ? text.normalize('NFC') : text;
  }

  function deepClone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  global.ImageImportWorkflow = Object.freeze({
    ACCEPTED_IMAGE_TYPES,
    MAX_IMAGE_BYTES,
    MAX_LECTURE_PDF_BYTES,
    collectImageSlots,
    collectPdfImportPlan,
    validateLecturePdfFile,
    applyImageSources,
    validateImageFile
  });
})(window);

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function patchIntentCarousel(distDirectory) {
  const path = resolve(distDirectory, 'image-candidate-carousel.js');
  let source = await readFile(path, 'utf8');

  source = replaceRequired(source, `    renderQueued: false,
    startSearchQueued: false,
    suppressNativeCapture: false`, `    renderQueued: false,
    startSearchQueued: false,
    activeSearches: 0,
    searchQueue: [],
    suppressNativeCapture: false`, 'search queue state');

  source = replaceRequired(source, `      state.slots = window.ImageImportWorkflow.collectImageSlots(source);
      state.definitions = source.imoo.images.map((item) => ({
        id: typeof item?.id === 'string' ? item.id.trim() : '',
        altTexts: collectAltTexts(item)
      })).filter((item) => item.id);`, `      state.slots = window.ImageImportWorkflow.collectImageSlots(source);
      const slotById = new Map(state.slots.filter((slot) => slot.sourceId).map((slot) => [slot.sourceId, slot]));
      state.definitions = source.imoo.images.map((item) => {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        const slot = slotById.get(id);
        return {
          id,
          label: slot?.label || (typeof item?.label === 'string' ? item.label.trim() : '') || id,
          altTexts: collectAltTexts(item)
        };
      }).filter((item) => item.id);`, 'definition payload');

  source = replaceRequired(source, `    state.cards.clear();
    state.startSearchQueued = false;`, `    state.cards.clear();
    state.startSearchQueued = false;
    state.searchQueue = [];`, 'queue reset');

  source = replaceRequired(source,
    "    status.textContent = cardState.searching ? 'Searching Wikimedia…' : cardState.error || `${cardState.candidates.length} choice${cardState.candidates.length === 1 ? '' : 's'}`;",
    [
      "    const usefulText = Number.isInteger(cardState.usefulCount) && cardState.usefulCount > 0",
      "      ? `${cardState.usefulCount} useful · `",
      "      : '';",
      "    status.textContent = cardState.searching ? 'Gemini is searching open media…' : cardState.error || `${usefulText}${cardState.candidates.length} choice${cardState.candidates.length === 1 ? '' : 's'}`;"
    ].join('\n'),
    'carousel status');

  source = replaceRequired(source,
    `        button.title = candidate.label;`,
    `        button.title = [candidate.label, candidate.creator, candidate.license, candidate.attribution].filter(Boolean).join(' · ');`,
    'candidate metadata title');

  source = replaceRequired(source, `    controls.append(
      actionButton('Save', () => saveSelected(definition.id)),
      actionButton('Delete', () => deleteSelected(definition.id, slotIndex)),
      addButton(definition.id, slotIndex)
    );
    shell.append(header, viewport, controls);`, `    controls.append(
      actionButton('Save', () => saveSelected(definition.id)),
      actionButton('Delete', () => deleteSelected(definition.id, slotIndex)),
      addButton(definition.id, slotIndex)
    );
    const selected = cardState.candidates.find((candidate) => candidate.key === cardState.selectedKey);
    const credit = document.createElement('div');
    credit.className = 'image-candidate-credit';
    if (selected) {
      const summary = document.createElement('span');
      summary.textContent = selected.attribution || [selected.label, selected.creator, selected.license].filter(Boolean).join(' — ');
      credit.append(summary);
      if (selected.sourcePage) {
        const sourceLink = document.createElement('a');
        sourceLink.href = selected.sourcePage;
        sourceLink.target = '_blank';
        sourceLink.rel = 'noopener noreferrer';
        sourceLink.textContent = 'Original source';
        credit.append(sourceLink);
      }
      if (selected.licenseUrl) {
        const licenseLink = document.createElement('a');
        licenseLink.href = selected.licenseUrl;
        licenseLink.target = '_blank';
        licenseLink.rel = 'noopener noreferrer';
        licenseLink.textContent = selected.license || 'License';
        credit.append(licenseLink);
      }
    } else {
      credit.textContent = 'Select an image to view its source, license, and attribution.';
    }
    shell.append(header, viewport, credit, controls);`, 'visible attribution');

  source = replaceRequired(source,
    `      if (startSearch && !cardState.searched && !cardState.searching) searchDefinition(definition);`,
    `      if (startSearch && !cardState.searched && !cardState.searching) enqueueSearch(definition);`,
    'queued search start');

  source = replaceRequired(source, `  async function searchDefinition(definition) {`, `  function enqueueSearch(definition) {
    const cardState = ensureCardState(definition.id);
    if (cardState.searched || cardState.searching || state.searchQueue.some((item) => item.id === definition.id)) return;
    cardState.error = 'Waiting for Gemini search…';
    state.searchQueue.push(definition);
    queueRender(false);
    drainSearchQueue();
  }

  function drainSearchQueue() {
    while (state.activeSearches < 2 && state.searchQueue.length) {
      const definition = state.searchQueue.shift();
      const cardState = ensureCardState(definition.id);
      if (cardState.searched || cardState.searching) continue;
      state.activeSearches += 1;
      searchDefinition(definition).finally(() => {
        state.activeSearches = Math.max(0, state.activeSearches - 1);
        drainSearchQueue();
      });
    }
  }

  async function searchDefinition(definition) {`, 'search queue functions');

  source = replaceRequired(source, `      for (const altText of definition.altTexts) {
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
          cardState.candidates.push({ key: \`wikimedia:\${url}\`, source: 'Wikimedia', label: altText, previewUrl: url, remoteUrl: url, file: null, revoke: false });
        }
      }`, `      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentSearch: true,
          strictRelevance: true,
          imageId: definition.id,
          label: definition.label,
          altTexts: definition.altTexts
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Media search could not finish.');
      cardState.usefulCount = Number.isInteger(result.usefulCount) ? result.usefulCount : 0;
      const candidateLabel = result.intentSummary || definition.label || definition.altTexts[0] || definition.id;
      const mediaItems = Array.isArray(result.imageResults) && result.imageResults.length
        ? result.imageResults
        : (result.images || []).map((url) => ({ url, source: 'Wikimedia Commons', title: candidateLabel }));
      for (const item of mediaItems) {
        const url = typeof item?.url === 'string' ? item.url : '';
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const sourceName = typeof item?.source === 'string' && item.source ? item.source : 'Wikimedia Commons';
        const sourceKey = sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        cardState.candidates.push({
          key: \`\${sourceKey}:\${url}\`,
          source: sourceName,
          label: item.title || candidateLabel,
          previewUrl: url,
          remoteUrl: url,
          originalUrl: item.originalUrl || url,
          creator: item.creator || '',
          creatorUrl: item.creatorUrl || '',
          license: item.license || '',
          licenseUrl: item.licenseUrl || '',
          attribution: item.attribution || '',
          sourcePage: item.sourcePage || '',
          resemblanceScore: Number(item.resemblanceScore) || 0,
          file: null,
          revoke: false
        });
      }`, 'single multi-source intent request');

  source = source
    .replaceAll('Finding reusable Wikimedia images…', 'Finding reusable images across open collections…')
    .replaceAll('PDF, Wikimedia, or added images will appear here.', 'PDF, open-collection, or added images will appear here.')
    .replaceAll('No Wikimedia images found.', 'No reusable matching images found.')
    .replaceAll('Wikimedia search could not finish.', 'Media search could not finish.')
    .replaceAll('Importing Wikimedia image for', 'Importing selected media for')
    .replaceAll('Wikimedia image returned', 'Selected media returned');

  await writeFile(path, source);
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch image carousel ${label}; source changed.`);
  return source.replace(search, replacement);
}
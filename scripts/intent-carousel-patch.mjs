import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function patchIntentCarousel(distDirectory) {
  const path = resolve(distDirectory, 'image-candidate-carousel.js');
  let source = await readFile(path, 'utf8');

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

  source = replaceRequired(source,
    "    status.textContent = cardState.searching ? 'Searching Wikimedia…' : cardState.error || `${cardState.candidates.length} choice${cardState.candidates.length === 1 ? '' : 's'}`;",
    [
      "    const usefulText = Number.isInteger(cardState.usefulCount) && cardState.usefulCount > 0",
      "      ? `${cardState.usefulCount} useful · `",
      "      : '';",
      "    status.textContent = cardState.searching ? 'Gemini is understanding and searching…' : cardState.error || `${usefulText}${cardState.candidates.length} choice${cardState.candidates.length === 1 ? '' : 's'}`;"
    ].join('\n'),
    'carousel status');

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
          imageId: definition.id,
          label: definition.label,
          altTexts: definition.altTexts
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Wikimedia search could not finish.');
      cardState.usefulCount = Number.isInteger(result.usefulCount) ? result.usefulCount : 0;
      const candidateLabel = result.intentSummary || definition.label || definition.altTexts[0] || definition.id;
      for (const url of result.images || []) {
        if (typeof url !== 'string' || seen.has(url)) continue;
        seen.add(url);
        cardState.candidates.push({ key: \`wikimedia:\${url}\`, source: 'Wikimedia', label: candidateLabel, previewUrl: url, remoteUrl: url, file: null, revoke: false });
      }`, 'single intent request');

  await writeFile(path, source);
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch image carousel ${label}; source changed.`);
  return source.replace(search, replacement);
}

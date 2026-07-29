import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function patchRefreshMediaResults(distDirectory) {
  const path = resolve(distDirectory, 'image-candidate-carousel.js');
  let source = await readFile(path, 'utf8');

  source = replaceRequired(source,
    "  elements.buildButton.addEventListener('click', () => queueRender(true));",
    `  elements.buildButton.addEventListener('click', () => {
    prepareAllCardsForFreshSearch();
    queueRender(true);
  });`,
    'fresh Build search');

  source = replaceRequired(source,
    "      state.cards.set(id, { id, candidates: [], selectedKey: '', searching: false, searched: false, error: '' });",
    "      state.cards.set(id, { id, candidates: [], selectedKey: '', searching: false, searched: false, error: '', searchRun: 0, excludedUrls: [] });",
    'search run state');

  source = replaceRequired(source, [
    "    controls.append(",
    "      actionButton('Save', () => saveSelected(definition.id)),",
    "      actionButton('Delete', () => deleteSelected(definition.id, slotIndex)),",
    "      addButton(definition.id, slotIndex)",
    "    );",
    "    const selected = cardState.candidates.find((candidate) => candidate.key === cardState.selectedKey);"
  ].join('\n'), [
    "    controls.append(",
    "      actionButton('Save', () => saveSelected(definition.id)),",
    "      actionButton('Delete', () => deleteSelected(definition.id, slotIndex)),",
    "      actionButton('Refresh choices', () => refreshChoices(definition.id)),",
    "      addButton(definition.id, slotIndex)",
    "    );",
    "    const selected = cardState.candidates.find((candidate) => candidate.key === cardState.selectedKey);"
  ].join('\n'), 'Refresh choices control');

  source = replaceRequired(source,
    '          altTexts: definition.altTexts\n        })',
    '          altTexts: definition.altTexts,\n          searchRun: cardState.searchRun,\n          excludedUrls: cardState.excludedUrls.slice(-120)\n        })',
    'fresh-search request metadata');

  source = replaceRequired(source, [
    "      cardState.engineLabel = result.engine === 'multi-source-v2'",
    "        ? 'Multi-source v2'",
    "        : result.multiSource === true ? 'Multi-source legacy' : 'Wikimedia-only fallback';"
  ].join('\n'), [
    "      cardState.engineLabel = result.engine === 'multi-source-v3'",
    "        ? `Multi-source v3 · run ${Number(result.searchRun) || cardState.searchRun}`",
    "        : result.engine === 'multi-source-v2'",
    "          ? 'Multi-source v2'",
    "          : result.multiSource === true ? 'Multi-source legacy' : 'Wikimedia-only fallback';"
  ].join('\n'), 'V3 engine label');

  source = replaceRequired(source, '  function formatProviderSummary(sourceCounts, providerDiagnostics) {', `  function prepareAllCardsForFreshSearch() {
    for (const definition of state.definitions) prepareCardForFreshSearch(definition.id, false);
  }

  function prepareCardForFreshSearch(id, clearSelectedInput) {
    const cardState = ensureCardState(id);
    if (cardState.searching) return false;
    const selected = cardState.candidates.find((candidate) => candidate.key === cardState.selectedKey);
    const selectedWasRemote = Boolean(selected?.remoteUrl);
    const excluded = new Set(Array.isArray(cardState.excludedUrls) ? cardState.excludedUrls : []);
    for (const candidate of cardState.candidates) {
      if (!candidate.remoteUrl) continue;
      for (const value of [candidate.remoteUrl, candidate.originalUrl, candidate.sourcePage]) {
        if (typeof value === 'string' && value.startsWith('https://')) excluded.add(value);
      }
    }
    cardState.excludedUrls = [...excluded].slice(-120);
    cardState.candidates = cardState.candidates.filter((candidate) => !candidate.remoteUrl);
    if (selectedWasRemote) cardState.selectedKey = cardState.candidates[0]?.key || '';
    cardState.searchRun = Math.min(999, (Number(cardState.searchRun) || 0) + 1);
    cardState.searched = false;
    cardState.error = '';
    cardState.usefulCount = 0;
    cardState.engineLabel = '';
    cardState.sourceSummary = '';
    cardState.providerDetails = '';
    if (selectedWasRemote && clearSelectedInput) {
      const index = slotIndexForId(id);
      if (Number.isInteger(index)) clearNativeInput(index);
    }
    return true;
  }

  function refreshChoices(id) {
    const definition = state.definitions.find((item) => item.id === id);
    if (!definition || !prepareCardForFreshSearch(id, true)) return;
    queueRender(false);
    enqueueSearch(definition);
  }

  function formatProviderSummary(sourceCounts, providerDiagnostics) {`, 'fresh-search helpers');

  await writeFile(path, source, 'utf8');
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch fresh media results: ${label} source changed.`);
  return source.replace(search, replacement);
}

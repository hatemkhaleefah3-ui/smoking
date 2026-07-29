import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function patchProviderObservability(distDirectory) {
  const path = resolve(distDirectory, 'image-candidate-carousel.js');
  let source = await readFile(path, 'utf8');

  source = replaceRequired(source, [
    "    const usefulText = Number.isInteger(cardState.usefulCount) && cardState.usefulCount > 0",
    "      ? `${cardState.usefulCount} useful · `",
    "      : '';",
    "    status.textContent = cardState.searching ? 'Gemini is searching open media…' : cardState.error || `${usefulText}${cardState.candidates.length} choice${cardState.candidates.length === 1 ? '' : 's'}`;"
  ].join('\n'), [
    "    const usefulText = Number.isInteger(cardState.usefulCount) && cardState.usefulCount > 0",
    "      ? `${cardState.usefulCount} useful · `",
    "      : '';",
    "    const engineText = cardState.engineLabel ? `${cardState.engineLabel} · ` : '';",
    "    const sourceText = cardState.sourceSummary ? ` · ${cardState.sourceSummary}` : '';",
    "    status.textContent = cardState.searching ? 'Gemini is searching open media…' : cardState.error || `${engineText}${usefulText}${cardState.candidates.length} choice${cardState.candidates.length === 1 ? '' : 's'}${sourceText}`;",
    "    status.title = cardState.providerDetails || '';"
  ].join('\n'), 'provider-aware status');

  source = replaceRequired(source, [
    "      cardState.usefulCount = Number.isInteger(result.usefulCount) ? result.usefulCount : 0;",
    "      const candidateLabel = result.intentSummary || definition.label || definition.altTexts[0] || definition.id;"
  ].join('\n'), [
    "      cardState.usefulCount = Number.isInteger(result.usefulCount) ? result.usefulCount : 0;",
    "      cardState.engineLabel = result.engine === 'multi-source-v3'",
    "        ? 'Multi-source v3'",
    "        : result.multiSource === true ? 'Multi-source legacy' : 'Wikimedia-only fallback';",
    "      const providerInfo = formatProviderSummary(result.sourceCounts, result.providerDiagnostics);",
    "      cardState.sourceSummary = providerInfo.summary;",
    "      cardState.providerDetails = providerInfo.details;",
    "      const candidateLabel = result.intentSummary || definition.label || definition.altTexts[0] || definition.id;"
  ].join('\n'), 'provider result metadata');

  source = replaceRequired(source, '  function captureNativeSelection(event) {', [
    "  function formatProviderSummary(sourceCounts, providerDiagnostics) {",
    "    const labels = { 'Wikimedia Commons': 'Wikimedia', Openverse: 'Openverse', 'Wellcome Collection': 'Wellcome' };",
    "    const accepted = sourceCounts && typeof sourceCounts === 'object' ? sourceCounts : {};",
    "    const diagnostics = providerDiagnostics && typeof providerDiagnostics === 'object' ? providerDiagnostics : {};",
    "    const summaryParts = [];",
    "    const detailParts = [];",
    "    for (const source of ['Wikimedia Commons', 'Openverse', 'Wellcome Collection']) {",
    "      const count = Number(accepted[source]) || 0;",
    "      const status = diagnostics[source] || {};",
    "      const found = Number(status.found) || 0;",
    "      const loaded = Number(status.loaded) || 0;",
    "      const errors = (Number(status.searchErrors) || 0) + (Number(status.imageErrors) || 0);",
    "      if (Object.keys(status).length) summaryParts.push(`${labels[source]} ${count} accepted/${loaded} loaded`);",
    "      else if (count > 0) summaryParts.push(`${labels[source]} ${count} accepted`);",
    "      if (Object.keys(status).length) {",
    "        detailParts.push(`${labels[source]}: ${found} found, ${loaded} loaded, ${count} accepted${errors ? `, ${errors} errors` : ''}`);",
    "      }",
    "    }",
    "    return {",
    "      summary: summaryParts.join(' · '),",
    "      details: detailParts.join(' | ')",
    "    };",
    "  }",
    "",
    "  function captureNativeSelection(event) {"
  ].join('\n'), 'provider summary helper');

  await writeFile(path, source);
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch provider observability ${label}; generated carousel changed.`);
  return source.replace(search, replacement);
}

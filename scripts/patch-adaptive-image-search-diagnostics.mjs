import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDrivenPath = resolve(root, 'worker/src/image-search-data-driven.js');
const frontendPath = resolve(root, 'adaptive-image-search.js');
const cssPath = resolve(root, 'adaptive-image-search-data-driven.css');

export async function patchAdaptiveImageSearchDiagnostics() {
  await patchDataDrivenWorker();
  await patchFrontend();
  await patchStyles();
}

async function patchDataDrivenWorker() {
  let source = await readFile(dataDrivenPath, 'utf8');
  if (source.includes("const DIAGNOSTIC_PIPELINE_VERSION = 'part0-v1';")) return;

  source = replaceRequired(
    source,
    `const SIMILARITY_PROPAGATION = 0.55;`,
    `const SIMILARITY_PROPAGATION = 0.55;\nconst DIAGNOSTIC_PIPELINE_VERSION = 'part0-v1';`,
    'pipeline diagnostic version'
  );

  source = replaceRequired(
    source,
    `  if (!retry && cacheBucket) {`,
    `  if (!retry && !debug && cacheBucket) {`,
    'live debug cache bypass'
  );

  source = replaceRequired(
    source,
    `  if (requiresKeyword) {\n    return json({`,
    `  if (requiresKeyword) {\n    const debugDiagnostics = buildDebugDiagnostics({\n      poolPayload,\n      rawPoolCount: rawPool.length,\n      afterKeywordFilterCount: rawPool.length,\n      afterFeedbackRankingCount: 0,\n      finalCountPassedToRender: 0,\n      selectedKeyword: null,\n      keywordSelectionRequired: true,\n      cacheHit\n    });\n    logPipelineDiagnostics(query, debugDiagnostics);\n    return json({`,
    'keyword-selection pipeline diagnostics'
  );

  source = replaceRequired(
    source,
    `  const feedbackState = await loadFeedbackState(env.DB);\n  const ranked = rankWithFeedback(filter.results, feedbackState, chosen)\n    .slice(0, MAX_VISIBLE_RESULTS)\n    .map(stripInternalAnalysis);`,
    `  const feedbackState = await loadFeedbackState(env.DB);\n  const feedbackRanked = rankWithFeedback(filter.results, feedbackState, chosen);\n  const ranked = feedbackRanked\n    .slice(0, MAX_VISIBLE_RESULTS)\n    .map(stripInternalAnalysis);`,
    'feedback ranking stage count'
  );

  source = replaceRequired(
    source,
    `  return json({\n    requiresTopic: false,\n    requiresKeyword: false,`,
    `  const debugDiagnostics = buildDebugDiagnostics({\n    poolPayload,\n    rawPoolCount: rawPool.length,\n    afterKeywordFilterCount: filter.results.length,\n    afterFeedbackRankingCount: feedbackRanked.length,\n    finalCountPassedToRender: ranked.length,\n    selectedKeyword: chosen,\n    keywordSelectionRequired: false,\n    cacheHit\n  });\n  logPipelineDiagnostics(query, debugDiagnostics);\n\n  return json({\n    requiresTopic: false,\n    requiresKeyword: false,`,
    'ranked-result pipeline diagnostics'
  );

  source = replaceAllRequired(
    source,
    `      ...(debug ? { debugDiagnostics: { providers: poolPayload.diagnostics || [] } } : {})`,
    `      ...(debug ? { debugDiagnostics } : {})`,
    1,
    'keyword-selection debug response'
  );

  source = replaceAllRequired(
    source,
    `    ...(debug ? { debugDiagnostics: { providers: poolPayload.diagnostics || [] } } : {})`,
    `    ...(debug ? { debugDiagnostics } : {})`,
    1,
    'ranked-result debug response'
  );

  source = replaceRequired(
    source,
    `async function saveFeedback(request, env, url) {`,
    `function buildDebugDiagnostics({\n  poolPayload,\n  rawPoolCount,\n  afterKeywordFilterCount,\n  afterFeedbackRankingCount,\n  finalCountPassedToRender,\n  selectedKeyword,\n  keywordSelectionRequired,\n  cacheHit\n}) {\n  const providerPipeline = poolPayload?.pipelineCounts || {};\n  return {\n    version: DIAGNOSTIC_PIPELINE_VERSION,\n    providers: Array.isArray(poolPayload?.diagnostics) ? poolPayload.diagnostics : [],\n    sourceStatus: Array.isArray(poolPayload?.sourceStatus) ? poolPayload.sourceStatus : [],\n    cache: {\n      hit: Boolean(cacheHit),\n      liveProviderRequests: !cacheHit\n    },\n    pipeline: {\n      rawByProvider: providerPipeline.rawByProvider || {},\n      afterProviderFilteringByProvider: providerPipeline.afterProviderFilteringByProvider || {},\n      beforeCrossProviderDedup: Number(providerPipeline.beforeCrossProviderDedup || rawPoolCount || 0),\n      afterCrossProviderDedup: Number(providerPipeline.afterCrossProviderDedup || rawPoolCount || 0),\n      afterKeywordFiltering: Number(afterKeywordFilterCount || 0),\n      afterFeedbackRankingOrDemotion: Number(afterFeedbackRankingCount || 0),\n      finalCountPassedToRender: Number(finalCountPassedToRender || 0),\n      finalDomRenderedCount: null,\n      keywordSelectionRequired: Boolean(keywordSelectionRequired),\n      selectedKeyword: selectedKeyword?.keyword || null\n    }\n  };\n}\n\nfunction logPipelineDiagnostics(query, diagnostics) {\n  console.log(JSON.stringify({\n    event: 'adaptive_image_pipeline_counts',\n    query,\n    cache: diagnostics.cache,\n    pipeline: diagnostics.pipeline\n  }));\n}\n\nasync function saveFeedback(request, env, url) {`,
    'pipeline diagnostic helpers'
  );

  await writeFile(dataDrivenPath, source, 'utf8');
}

async function patchFrontend() {
  let source = await readFile(frontendPath, 'utf8');
  if (source.includes('id="adaptive-image-debug-panel"')) return;

  source = replaceRequired(
    source,
    `    <div id="adaptive-image-source-status" class="adaptive-image-source-status" hidden></div>\n    <div id="adaptive-image-results" class="adaptive-image-results" hidden></div>`,
    `    <div id="adaptive-image-source-status" class="adaptive-image-source-status" hidden></div>\n    <details id="adaptive-image-debug-panel" class="adaptive-image-debug-panel" hidden>\n      <summary>Search diagnostics</summary>\n      <div id="adaptive-image-debug-content" class="adaptive-image-debug-content"></div>\n    </details>\n    <div id="adaptive-image-results" class="adaptive-image-results" hidden></div>`,
    'debug panel markup'
  );

  source = replaceRequired(
    source,
    `    sourceStatus: panel.querySelector('#adaptive-image-source-status'),\n    results: panel.querySelector('#adaptive-image-results')`,
    `    sourceStatus: panel.querySelector('#adaptive-image-source-status'),\n    debugPanel: panel.querySelector('#adaptive-image-debug-panel'),\n    debugContent: panel.querySelector('#adaptive-image-debug-content'),\n    results: panel.querySelector('#adaptive-image-results')`,
    'debug panel element references'
  );

  source = replaceRequired(
    source,
    `    controller: null,\n    requestSequence: 0`,
    `    controller: null,\n    requestSequence: 0,\n    debugDiagnostics: null,\n    renderCounts: { passed: null, dom: null }`,
    'debug panel state'
  );

  source = replaceRequired(
    source,
    `      renderSourceStatus(payload.sourceStatus || [], payload.cacheHit);\n      elements.retry.hidden = false;`,
    `      renderSourceStatus(payload.sourceStatus || [], payload.cacheHit);\n      state.debugDiagnostics = payload.debugDiagnostics || null;\n      state.renderCounts = {\n        passed: Number(payload.debugDiagnostics?.pipeline?.finalCountPassedToRender ?? payload.resultCount ?? 0),\n        dom: null\n      };\n      renderDebugDiagnostics();\n      elements.retry.hidden = false;`,
    'debug payload rendering'
  );

  source = replaceRequired(
    source,
    `        elements.results.replaceChildren();\n        elements.results.hidden = true;`,
    `        elements.results.replaceChildren();\n        elements.results.hidden = true;\n        scheduleRenderedCountMeasurement(0);`,
    'keyword gate DOM measurement'
  );

  source = replaceRequired(
    source,
    `      renderResults(state.results);`,
    `      renderResults(state.results, Number(payload.resultCount ?? state.results.length));`,
    'render input count measurement'
  );

  source = replaceRequired(
    source,
    `      if (item.ok) {\n        chip.className = 'is-ready';\n        chip.textContent = \`${'${sourceLabel(item.source)}'} · ${'${Number(item.count || 0)}'}\`;\n      } else if (item.timedOut) {\n        chip.className = 'is-unavailable is-soft-skip';\n        chip.textContent = item.message || \`${'${sourceLabel(item.source)}'} timed out · other sources shown\`;\n      } else if (item.skipped) {\n        chip.className = 'is-unavailable is-soft-skip';\n        chip.textContent = item.message || \`${'${sourceLabel(item.source)}'} skipped · other sources shown\`;\n      } else {\n        chip.className = 'is-unavailable';\n        chip.textContent = \`${'${sourceLabel(item.source)}'} unavailable\`;\n      }`,
    `      if (item.ok) {\n        chip.className = 'is-ready';\n        chip.textContent = \`${'${sourceLabel(item.source)}'} · ${'${Number(item.count || 0)}'}\`;\n      } else if (item.failureType === 'network') {\n        chip.className = 'is-unavailable is-soft-skip is-network-error';\n        chip.textContent = \`${'${sourceLabel(item.source)}'} · no response (network/CORS error)\`;\n      } else if (item.failureType === 'timeout' || item.timedOut) {\n        chip.className = 'is-unavailable is-soft-skip is-timeout-error';\n        chip.textContent = item.message || \`${'${sourceLabel(item.source)}'} timed out · other sources shown\`;\n      } else if (item.failureType === 'http') {\n        chip.className = 'is-unavailable is-soft-skip is-server-error';\n        chip.textContent = \`${'${sourceLabel(item.source)}'} · server returned${'${item.status == null ? " an error" : ` HTTP ${item.status}`}'}\`;\n      } else if (item.failureType === 'parse') {\n        chip.className = 'is-unavailable is-soft-skip is-parse-error';\n        chip.textContent = \`${'${sourceLabel(item.source)}'} · unreadable response\`;\n      } else if (item.skipped) {\n        chip.className = 'is-unavailable is-soft-skip';\n        chip.textContent = item.message || \`${'${sourceLabel(item.source)}'} skipped · other sources shown\`;\n      } else {\n        chip.className = 'is-unavailable';\n        chip.textContent = \`${'${sourceLabel(item.source)}'} unavailable\`;\n      }`,
    'provider error type labels'
  );

  source = replaceRequired(
    source,
    `  function renderResults(results) {\n    elements.results.replaceChildren();\n    for (const result of results) elements.results.append(createResultCard(result));\n    elements.results.hidden = !elements.results.childElementCount;\n  }`,
    `  function renderResults(results, passedCount = results.length) {\n    elements.results.replaceChildren();\n    for (const result of results) elements.results.append(createResultCard(result));\n    elements.results.hidden = !elements.results.childElementCount;\n    scheduleRenderedCountMeasurement(passedCount);\n  }`,
    'post-render DOM measurement'
  );

  source = replaceRequired(
    source,
    `  function createResultCard(result) {`,
    `  function scheduleRenderedCountMeasurement(passedCount) {\n    state.renderCounts.passed = Number(passedCount || 0);\n    const schedule = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));\n    schedule(() => schedule(() => {\n      const domCount = elements.results.querySelectorAll('.adaptive-image-card').length;\n      state.renderCounts.dom = domCount;\n      if (state.debugDiagnostics?.pipeline) {\n        state.debugDiagnostics.pipeline.finalCountPassedToRender = state.renderCounts.passed;\n        state.debugDiagnostics.pipeline.finalDomRenderedCount = domCount;\n      }\n      console.info('[adaptive-image-search] render count diagnostic', {\n        passedToRender: state.renderCounts.passed,\n        renderedInDom: domCount,\n        matches: state.renderCounts.passed === domCount\n      });\n      renderDebugDiagnostics();\n    }));\n  }\n\n  function renderDebugDiagnostics() {\n    if (!DEBUG_MODE || !elements.debugPanel || !elements.debugContent) return;\n    elements.debugPanel.hidden = false;\n    elements.debugContent.replaceChildren();\n\n    const diagnostics = state.debugDiagnostics || {};\n    const pipeline = diagnostics.pipeline || {};\n    const providers = Array.isArray(diagnostics.providers) ? diagnostics.providers : [];\n\n    const pipelineSection = document.createElement('section');\n    pipelineSection.className = 'adaptive-debug-section';\n    const pipelineTitle = document.createElement('h4');\n    pipelineTitle.textContent = 'Pipeline stage counts';\n    pipelineSection.append(pipelineTitle);\n    const pipelineList = document.createElement('dl');\n    pipelineList.className = 'adaptive-debug-grid';\n    appendDiagnosticRow(pipelineList, 'Raw by provider', JSON.stringify(pipeline.rawByProvider || {}));\n    appendDiagnosticRow(pipelineList, 'After provider filtering', JSON.stringify(pipeline.afterProviderFilteringByProvider || {}));\n    appendDiagnosticRow(pipelineList, 'Before cross-provider dedup', pipeline.beforeCrossProviderDedup);\n    appendDiagnosticRow(pipelineList, 'After cross-provider dedup', pipeline.afterCrossProviderDedup);\n    appendDiagnosticRow(pipelineList, 'After keyword/topic filtering', pipeline.afterKeywordFiltering);\n    appendDiagnosticRow(pipelineList, 'After feedback ranking/demotion', pipeline.afterFeedbackRankingOrDemotion);\n    appendDiagnosticRow(pipelineList, 'Passed to render', state.renderCounts.passed ?? pipeline.finalCountPassedToRender);\n    appendDiagnosticRow(pipelineList, 'Actually rendered in DOM', state.renderCounts.dom ?? pipeline.finalDomRenderedCount);\n    const mismatch = state.renderCounts.passed != null && state.renderCounts.dom != null && state.renderCounts.passed !== state.renderCounts.dom;\n    appendDiagnosticRow(pipelineList, 'Render count match', mismatch ? 'MISMATCH' : state.renderCounts.dom == null ? 'Pending measurement' : 'Match');\n    pipelineSection.classList.toggle('has-count-mismatch', mismatch);\n    pipelineSection.append(pipelineList);\n    elements.debugContent.append(pipelineSection);\n\n    const providerSection = document.createElement('section');\n    providerSection.className = 'adaptive-debug-section';\n    const providerTitle = document.createElement('h4');\n    providerTitle.textContent = 'Provider request / response diagnostics';\n    providerSection.append(providerTitle);\n\n    if (!providers.length) {\n      const empty = document.createElement('p');\n      empty.textContent = diagnostics.cache?.hit\n        ? 'This response came from cache and contains no live provider attempt details.'\n        : 'No provider attempt diagnostics were returned.';\n      providerSection.append(empty);\n    }\n\n    for (const attempt of providers) {\n      const card = document.createElement('article');\n      card.className = 'adaptive-debug-provider';\n      const heading = document.createElement('h5');\n      heading.textContent = \`${'${sourceLabel(attempt.source)}'} · ${'${attempt.stage || "request"}'}\`;\n      card.append(heading);\n      const list = document.createElement('dl');\n      list.className = 'adaptive-debug-grid';\n      appendDiagnosticRow(list, 'Request URL', attempt.requestUrl || '—');\n      appendDiagnosticRow(list, 'Fetch threw', String(Boolean(attempt.fetchThrew)));\n      appendDiagnosticRow(list, 'Fetch JS error', [attempt.fetchErrorName, attempt.fetchErrorMessage].filter(Boolean).join(': ') || '—');\n      appendDiagnosticRow(list, 'Failure type', attempt.failureType || 'none');\n      appendDiagnosticRow(list, 'HTTP status', attempt.responseStatus ?? attempt.status ?? 'no response');\n      appendDiagnosticRow(list, 'response.ok', attempt.responseOk ?? attempt.ok ?? 'no response');\n      appendDiagnosticRow(list, 'Raw parsed result count', attempt.parsedResultCount ?? 'not parsed');\n      appendDiagnosticRow(list, 'After provider filtering', attempt.afterProviderFilterCount ?? 'not available');\n      appendDiagnosticRow(list, 'Response body preview', attempt.rawBodyPreview || '—');\n      card.append(list);\n      providerSection.append(card);\n    }\n    elements.debugContent.append(providerSection);\n  }\n\n  function appendDiagnosticRow(list, label, value) {\n    const term = document.createElement('dt');\n    term.textContent = label;\n    const description = document.createElement('dd');\n    description.textContent = value == null ? '—' : String(value);\n    list.append(term, description);\n  }\n\n  function createResultCard(result) {`,
    'debug panel renderer'
  );

  await writeFile(frontendPath, source, 'utf8');
}

async function patchStyles() {
  let css = await readFile(cssPath, 'utf8');
  if (css.includes('.adaptive-image-debug-panel')) return;
  css += `\n\n/* Part 0: adaptive provider and pipeline diagnostics */\n.adaptive-image-debug-panel {\n  margin-block: 1rem;\n  border: 1px solid var(--border, #d6dbe4);\n  border-radius: 0.8rem;\n  background: color-mix(in srgb, var(--surface, #fff) 94%, #eef4ff);\n}\n\n.adaptive-image-debug-panel > summary {\n  cursor: pointer;\n  padding: 0.85rem 1rem;\n  font-weight: 700;\n}\n\n.adaptive-image-debug-content {\n  display: grid;\n  gap: 1rem;\n  padding: 0 1rem 1rem;\n}\n\n.adaptive-debug-section {\n  min-width: 0;\n  padding: 0.85rem;\n  border: 1px solid var(--border, #d6dbe4);\n  border-radius: 0.7rem;\n  background: var(--surface, #fff);\n}\n\n.adaptive-debug-section.has-count-mismatch {\n  border-color: #b42318;\n}\n\n.adaptive-debug-provider {\n  margin-top: 0.75rem;\n  padding-top: 0.75rem;\n  border-top: 1px solid var(--border, #d6dbe4);\n}\n\n.adaptive-debug-grid {\n  display: grid;\n  grid-template-columns: minmax(9rem, 0.45fr) minmax(0, 1fr);\n  gap: 0.35rem 0.8rem;\n  margin: 0.6rem 0 0;\n  font-size: 0.84rem;\n}\n\n.adaptive-debug-grid dt {\n  font-weight: 700;\n}\n\n.adaptive-debug-grid dd {\n  min-width: 0;\n  margin: 0;\n  overflow-wrap: anywhere;\n  white-space: pre-wrap;\n}\n\n@media (max-width: 640px) {\n  .adaptive-debug-grid {\n    grid-template-columns: 1fr;\n  }\n\n  .adaptive-debug-grid dd {\n    margin-bottom: 0.45rem;\n  }\n}\n`;
  await writeFile(cssPath, css, 'utf8');
}

function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Could not patch ${label}.`);
  return source.replace(before, after);
}

function replaceAllRequired(source, before, after, expectedCount, label) {
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`Could not patch ${label}: expected ${expectedCount} occurrence(s), found ${count}.`);
  }
  return source.replaceAll(before, after);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await patchAdaptiveImageSearchDiagnostics();
  console.log('Patched adaptive image search provider and pipeline diagnostics.');
}

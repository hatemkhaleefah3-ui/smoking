'use strict';

(() => {
  const existingSearchForm = document.querySelector('#media-search-form');
  if (!existingSearchForm || document.querySelector('#adaptive-image-search')) return;

  const DEBUG_MODE = new URLSearchParams(window.location.search).has('imageSearchDebug');
  const MAX_SEARCH_WAIT_MS = 15_000;
  const EXTRACTION_PHASE_DELAY_MS = 1_100;

  const panel = document.createElement('section');
  panel.id = 'adaptive-image-search';
  panel.className = 'adaptive-image-search panel';
  panel.setAttribute('aria-labelledby', 'adaptive-image-search-title');
  panel.innerHTML = `
    <header class="adaptive-image-search-heading">
      <div>
        <p class="step-kicker">Feedback-ranked multi-source search</p>
        <h3 id="adaptive-image-search-title">Search Wikimedia, Openverse and NLM Open-i.</h3>
        <p>Caption keywords are discovered from live results. Likes and dislikes reshape future ranking without deleting images.</p>
      </div>
      <span class="adaptive-learning-badge">Learns from feedback</span>
    </header>
    <form id="adaptive-image-search-form" class="adaptive-image-search-form" novalidate>
      <label for="adaptive-image-search-input">Search all free image sources</label>
      <div class="adaptive-image-search-command">
        <span class="adaptive-search-mark" aria-hidden="true"></span>
        <input id="adaptive-image-search-input" type="search" maxlength="160" autocomplete="off" placeholder="Try heart, glycine, nephron anatomy…">
        <button id="adaptive-image-search-submit" class="button button-primary" type="submit" aria-label="Search adaptive image sources">Search</button>
      </div>
    </form>
    <div id="adaptive-image-topic-panel" class="adaptive-image-topic-panel" hidden>
      <strong>Refine by a caption keyword</strong>
      <p>These choices come from repeated, distinctive words in sentences that mention your search term. Overlap is allowed.</p>
      <div id="adaptive-image-topic-options" class="adaptive-image-topic-options" role="group" aria-label="Caption keyword choices"></div>
    </div>
    <div class="adaptive-image-search-toolbar">
      <div id="adaptive-image-search-status" class="status status-neutral" role="status" aria-live="polite">Enter a term to search three live image sources.</div>
      <button id="adaptive-image-search-retry" class="button button-secondary" type="button" data-keep-text hidden>Refresh and re-rank</button>
    </div>
    <div id="adaptive-image-source-status" class="adaptive-image-source-status" hidden></div>
    <details id="adaptive-image-debug-panel" class="adaptive-image-debug-panel" hidden>
      <summary>Search diagnostics</summary>
      <div id="adaptive-image-debug-content" class="adaptive-image-debug-content"></div>
    </details>
    <div id="adaptive-image-results" class="adaptive-image-results" hidden></div>
  `;
  existingSearchForm.insertAdjacentElement('afterend', panel);

  const elements = {
    form: panel.querySelector('#adaptive-image-search-form'),
    input: panel.querySelector('#adaptive-image-search-input'),
    submit: panel.querySelector('#adaptive-image-search-submit'),
    keywordPanel: panel.querySelector('#adaptive-image-topic-panel'),
    keywordOptions: panel.querySelector('#adaptive-image-topic-options'),
    retry: panel.querySelector('#adaptive-image-search-retry'),
    status: panel.querySelector('#adaptive-image-search-status'),
    sourceStatus: panel.querySelector('#adaptive-image-source-status'),
    debugPanel: panel.querySelector('#adaptive-image-debug-panel'),
    debugContent: panel.querySelector('#adaptive-image-debug-content'),
    results: panel.querySelector('#adaptive-image-results')
  };

  const state = {
    query: '',
    keyword: null,
    keywordOptions: [],
    results: [],
    voting: new Set(),
    controller: null,
    requestSequence: 0,
    debugDiagnostics: null,
    renderCounts: { passed: null, dom: null }
  };

  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = elements.input.value.replace(/\s+/g, ' ').trim();
    if (!query) {
      setStatus('Enter an image search term.', 'error');
      elements.input.focus();
      return;
    }
    state.query = query;
    state.keyword = null;
    state.keywordOptions = [];
    runSearch({ retry: false, keyword: null });
  });

  elements.retry.addEventListener('click', () => {
    if (!state.query) return;
    runSearch({ retry: true, keyword: state.keyword });
  });

  async function runSearch({ retry = false, keyword = state.keyword } = {}) {
    const sequence = ++state.requestSequence;
    state.controller?.abort('superseded');
    const controller = new AbortController();
    state.controller = controller;
    setLoading(true, 'providers');
    elements.sourceStatus.hidden = true;
    elements.results.hidden = true;
    if (!state.keywordOptions.length) elements.keywordPanel.hidden = true;
    setStatus(retry ? 'Refreshing the broad result pool and applying learned ranking…' : 'Searching live image providers…', 'neutral');

    const extractionTimer = setTimeout(() => {
      if (sequence !== state.requestSequence || controller.signal.aborted) return;
      setLoading(true, 'extracting');
      setStatus('Extracting distinctive caption keywords and calculating overlap…', 'neutral');
    }, EXTRACTION_PHASE_DELAY_MS);
    const maximumTimer = setTimeout(() => controller.abort('client-maximum-wait'), MAX_SEARCH_WAIT_MS);

    try {
      const response = await fetch('/api/image-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ query: state.query, keyword, retry: Boolean(retry), debug: DEBUG_MODE })
      });
      const payload = await readJsonResponse(response);
      if (DEBUG_MODE) console.info('[adaptive-image-search] raw API response', payload);
      if (!response.ok) throw new Error(payload.error || `Image search failed with status ${response.status}.`);
      if (sequence !== state.requestSequence) return;

      state.keywordOptions = Array.isArray(payload.keywordOptions) ? payload.keywordOptions : [];
      renderKeywordChoices(state.keywordOptions, payload.keyword || keyword || null);
      renderSourceStatus(payload.sourceStatus || [], payload.cacheHit);
      state.debugDiagnostics = payload.debugDiagnostics || null;
      state.renderCounts = {
        passed: Number(payload.debugDiagnostics?.pipeline?.finalCountPassedToRender ?? payload.resultCount ?? 0),
        dom: null
      };
      renderDebugDiagnostics();
      elements.retry.hidden = false;

      if (payload.requiresKeyword === true) {
        state.keyword = null;
        elements.results.replaceChildren();
        elements.results.hidden = true;
        scheduleRenderedCountMeasurement(0);
        elements.keywordPanel.hidden = false;
        elements.keywordPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const dropped = Number(payload.keywordExtraction?.genericDropped || 0);
        const genericText = dropped ? ` ${dropped} generic overlapping term${dropped === 1 ? ' was' : 's were'} removed.` : '';
        setStatus(`Choose one distinctive caption keyword. Every option filters the same full result pool independently.${genericText}`, 'neutral');
        return;
      }

      state.keyword = payload.keyword || keyword || null;
      state.results = Array.isArray(payload.results) ? payload.results : [];
      renderKeywordChoices(state.keywordOptions, state.keyword);
      renderResults(state.results, Number(payload.resultCount ?? state.results.length));

      const keywordText = state.keyword?.label ? ` for “${state.keyword.label}”` : '';
      const filterText = payload.filter?.fallbackUsed ? ` Progressive fallback used: ${formatFilterMode(payload.filter.mode)}.` : '';
      const cacheText = payload.cacheHit ? ' Broad provider metadata came from the seven-day cache.' : '';
      const partialText = (payload.sourceStatus || []).some((item) => item.skipped) ? ' One source was skipped; available sources are shown.' : '';

      if (!state.results.length) {
        setStatus(`No images matched${keywordText}. Try another keyword or refresh the broad search.${partialText}`, 'error');
      } else {
        setStatus(`${state.results.length} image${state.results.length === 1 ? '' : 's'} ranked${keywordText}.${filterText}${cacheText}${partialText}`, 'success');
      }
    } catch (error) {
      if (sequence !== state.requestSequence) return;
      const timedOut = controller.signal.aborted && controller.signal.reason === 'client-maximum-wait';
      setStatus(timedOut ? 'The search reached its maximum wait time. Available providers may be slow; try again.' : error.message || 'The adaptive image search failed. Try again.', 'error');
      elements.retry.hidden = !state.query;
    } finally {
      clearTimeout(extractionTimer);
      clearTimeout(maximumTimer);
      if (sequence === state.requestSequence) {
        state.controller = null;
        setLoading(false);
      }
    }
  }

  function renderKeywordChoices(options, selected) {
    elements.keywordOptions.replaceChildren();
    if (!options.length) {
      elements.keywordPanel.hidden = true;
      return;
    }

    const allButton = document.createElement('button');
    allButton.type = 'button';
    allButton.className = 'adaptive-topic-choice';
    allButton.dataset.keepText = 'true';
    allButton.textContent = 'All results';
    allButton.setAttribute('aria-pressed', String(!selected));
    allButton.classList.toggle('is-selected', !selected);
    allButton.addEventListener('click', () => {
      state.keyword = null;
      runSearch({ retry: false, keyword: null });
    });
    elements.keywordOptions.append(allButton);

    for (const option of options.slice(0, 6)) {
      const isSelected = Boolean(selected && (selected.keyword === option.keyword || selected.label === option.label));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'adaptive-topic-choice';
      button.dataset.keepText = 'true';
      button.textContent = `${option.label} · ${Number(option.frequency || 0)}`;
      button.title = `Frequency ${option.frequency}; distinctiveness ${Math.round(Number(option.distinctiveness || 0) * 100)}%`;
      button.setAttribute('aria-pressed', String(isSelected));
      button.classList.toggle('is-selected', isSelected);
      button.addEventListener('click', () => {
        state.keyword = option;
        runSearch({ retry: false, keyword: option });
      });
      elements.keywordOptions.append(button);
    }
    elements.keywordPanel.hidden = false;
  }

  function renderSourceStatus(items, cacheHit) {
    elements.sourceStatus.replaceChildren();
    if (cacheHit) {
      const cached = document.createElement('span');
      cached.className = 'is-cached';
      cached.textContent = '7-day broad-result cache';
      elements.sourceStatus.append(cached);
    }
    for (const item of items) {
      const chip = document.createElement('span');
      if (item.ok) {
        chip.className = 'is-ready';
        chip.textContent = `${sourceLabel(item.source)} · ${Number(item.count || 0)}`;
      } else if (item.failureType === 'network') {
        chip.className = 'is-unavailable is-soft-skip is-network-error';
        chip.textContent = `${sourceLabel(item.source)} · no response (network/CORS error)`;
      } else if (item.failureType === 'timeout' || item.timedOut) {
        chip.className = 'is-unavailable is-soft-skip is-timeout-error';
        chip.textContent = item.message || `${sourceLabel(item.source)} timed out · other sources shown`;
      } else if (item.failureType === 'http') {
        chip.className = 'is-unavailable is-soft-skip is-server-error';
        chip.textContent = `${sourceLabel(item.source)} · server returned${item.status == null ? " an error" : ` HTTP ${item.status}`}`;
      } else if (item.failureType === 'parse') {
        chip.className = 'is-unavailable is-soft-skip is-parse-error';
        chip.textContent = `${sourceLabel(item.source)} · unreadable response`;
      } else if (item.skipped) {
        chip.className = 'is-unavailable is-soft-skip';
        chip.textContent = item.message || `${sourceLabel(item.source)} skipped · other sources shown`;
      } else {
        chip.className = 'is-unavailable';
        chip.textContent = `${sourceLabel(item.source)} unavailable`;
      }
      chip.title = [item.error || '', item.status != null ? `HTTP ${item.status}` : '', item.requestUrl || ''].filter(Boolean).join(' · ');
      elements.sourceStatus.append(chip);
    }
    elements.sourceStatus.hidden = !elements.sourceStatus.childElementCount;
  }

  function renderResults(results, passedCount = results.length) {
    elements.results.replaceChildren();
    for (const result of results) elements.results.append(createResultCard(result));
    elements.results.hidden = !elements.results.childElementCount;
    scheduleRenderedCountMeasurement(passedCount);
  }

  function scheduleRenderedCountMeasurement(passedCount) {
    state.renderCounts.passed = Number(passedCount || 0);
    const schedule = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
    schedule(() => schedule(() => {
      const domCount = elements.results.querySelectorAll('.adaptive-image-card').length;
      state.renderCounts.dom = domCount;
      if (state.debugDiagnostics?.pipeline) {
        state.debugDiagnostics.pipeline.finalCountPassedToRender = state.renderCounts.passed;
        state.debugDiagnostics.pipeline.finalDomRenderedCount = domCount;
      }
      console.info('[adaptive-image-search] render count diagnostic', {
        passedToRender: state.renderCounts.passed,
        renderedInDom: domCount,
        matches: state.renderCounts.passed === domCount
      });
      renderDebugDiagnostics();
    }));
  }

  function renderDebugDiagnostics() {
    if (!DEBUG_MODE || !elements.debugPanel || !elements.debugContent) return;
    elements.debugPanel.hidden = false;
    elements.debugContent.replaceChildren();

    const diagnostics = state.debugDiagnostics || {};
    const pipeline = diagnostics.pipeline || {};
    const providers = Array.isArray(diagnostics.providers) ? diagnostics.providers : [];

    const pipelineSection = document.createElement('section');
    pipelineSection.className = 'adaptive-debug-section';
    const pipelineTitle = document.createElement('h4');
    pipelineTitle.textContent = 'Pipeline stage counts';
    pipelineSection.append(pipelineTitle);
    const pipelineList = document.createElement('dl');
    pipelineList.className = 'adaptive-debug-grid';
    appendDiagnosticRow(pipelineList, 'Raw by provider', JSON.stringify(pipeline.rawByProvider || {}));
    appendDiagnosticRow(pipelineList, 'After provider filtering', JSON.stringify(pipeline.afterProviderFilteringByProvider || {}));
    appendDiagnosticRow(pipelineList, 'Before cross-provider dedup', pipeline.beforeCrossProviderDedup);
    appendDiagnosticRow(pipelineList, 'After cross-provider dedup', pipeline.afterCrossProviderDedup);
    appendDiagnosticRow(pipelineList, 'After keyword/topic filtering', pipeline.afterKeywordFiltering);
    appendDiagnosticRow(pipelineList, 'After feedback ranking/demotion', pipeline.afterFeedbackRankingOrDemotion);
    appendDiagnosticRow(pipelineList, 'Passed to render', state.renderCounts.passed ?? pipeline.finalCountPassedToRender);
    appendDiagnosticRow(pipelineList, 'Actually rendered in DOM', state.renderCounts.dom ?? pipeline.finalDomRenderedCount);
    const mismatch = state.renderCounts.passed != null && state.renderCounts.dom != null && state.renderCounts.passed !== state.renderCounts.dom;
    appendDiagnosticRow(pipelineList, 'Render count match', mismatch ? 'MISMATCH' : state.renderCounts.dom == null ? 'Pending measurement' : 'Match');
    pipelineSection.classList.toggle('has-count-mismatch', mismatch);
    pipelineSection.append(pipelineList);
    elements.debugContent.append(pipelineSection);

    const providerSection = document.createElement('section');
    providerSection.className = 'adaptive-debug-section';
    const providerTitle = document.createElement('h4');
    providerTitle.textContent = 'Provider request / response diagnostics';
    providerSection.append(providerTitle);

    if (!providers.length) {
      const empty = document.createElement('p');
      empty.textContent = diagnostics.cache?.hit
        ? 'This response came from cache and contains no live provider attempt details.'
        : 'No provider attempt diagnostics were returned.';
      providerSection.append(empty);
    }

    for (const attempt of providers) {
      const card = document.createElement('article');
      card.className = 'adaptive-debug-provider';
      const heading = document.createElement('h5');
      heading.textContent = `${sourceLabel(attempt.source)} · ${attempt.stage || "request"}`;
      card.append(heading);
      const list = document.createElement('dl');
      list.className = 'adaptive-debug-grid';
      appendDiagnosticRow(list, 'Request URL', attempt.requestUrl || '—');
      appendDiagnosticRow(list, 'Fetch threw', String(Boolean(attempt.fetchThrew)));
      appendDiagnosticRow(list, 'Fetch JS error', [attempt.fetchErrorName, attempt.fetchErrorMessage].filter(Boolean).join(': ') || '—');
      appendDiagnosticRow(list, 'Failure type', attempt.failureType || 'none');
      appendDiagnosticRow(list, 'HTTP status', attempt.responseStatus ?? attempt.status ?? 'no response');
      appendDiagnosticRow(list, 'response.ok', attempt.responseOk ?? attempt.ok ?? 'no response');
      appendDiagnosticRow(list, 'Raw parsed result count', attempt.parsedResultCount ?? 'not parsed');
      appendDiagnosticRow(list, 'After provider filtering', attempt.afterProviderFilterCount ?? 'not available');
      appendDiagnosticRow(list, 'Response body preview', attempt.rawBodyPreview || '—');
      card.append(list);
      providerSection.append(card);
    }
    elements.debugContent.append(providerSection);
  }

  function appendDiagnosticRow(list, label, value) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value == null ? '—' : String(value);
    list.append(term, description);
  }

  function createResultCard(result) {
    const card = document.createElement('article');
    card.className = 'adaptive-image-card';
    card.dataset.imageUrl = result.imageUrl || '';
    card.dataset.feedbackScore = String(Number(result.feedbackScore || 0));
    card.dataset.rankingScore = String(Number(result.rankingScore || 0));
    card.dataset.providerRank = String(Number(result.providerRank || 0));

    const figure = document.createElement('figure');
    const image = document.createElement('img');
    const primaryUrl = String(result.imageUrl || '');
    const fallbackUrl = result.source === 'openverse' && String(result.thumbnailUrl || '') && String(result.thumbnailUrl) !== primaryUrl ? String(result.thumbnailUrl) : '';
    image.src = primaryUrl;
    image.alt = result.caption || result.title || `${result.sourceLabel || 'Search'} result`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    if (fallbackUrl) image.dataset.fallbackUrl = fallbackUrl;
    image.addEventListener('load', () => card.classList.remove('has-image-error'));
    image.addEventListener('error', () => {
      const fallback = image.dataset.fallbackUrl || '';
      if (fallback && image.dataset.fallbackAttempted !== 'true') {
        image.dataset.fallbackAttempted = 'true';
        card.classList.remove('has-image-error');
        image.src = fallback;
        return;
      }
      card.classList.add('has-image-error');
    });
    figure.append(image);

    const source = document.createElement('span');
    source.className = 'adaptive-image-source';
    source.textContent = result.sourceLabel || sourceLabel(result.source);
    figure.append(source);

    const feedbackBadge = document.createElement('span');
    feedbackBadge.className = 'adaptive-image-learned';
    feedbackBadge.dataset.feedbackBadge = 'true';
    figure.append(feedbackBadge);
    updateFeedbackBadge(card, feedbackBadge);

    const body = document.createElement('div');
    body.className = 'adaptive-image-card-body';
    const title = document.createElement('h4');
    title.textContent = result.title || 'Untitled image';
    body.append(title);
    if (result.caption) {
      const caption = document.createElement('p');
      caption.textContent = result.caption;
      body.append(caption);
    }

    const metadata = document.createElement('div');
    metadata.className = 'adaptive-image-metadata';
    if (result.creator) metadata.append(metadataItem('Creator', result.creator));
    if (result.license) metadata.append(metadataItem('License', result.license));
    if (Number(result.similarityFeedbackScore || 0)) metadata.append(metadataItem('Similar-feedback effect', formatSigned(result.similarityFeedbackScore)));
    body.append(metadata);

    const actions = document.createElement('div');
    actions.className = 'adaptive-image-actions';
    const sourceLink = document.createElement('a');
    sourceLink.href = result.sourceUrl || result.originalUrl || result.imageUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.className = 'adaptive-image-source-link';
    sourceLink.textContent = 'Source';
    sourceLink.dataset.keepText = 'true';
    actions.append(sourceLink);

    const voteGroup = document.createElement('div');
    voteGroup.className = 'adaptive-image-votes';
    voteGroup.setAttribute('role', 'group');
    voteGroup.setAttribute('aria-label', 'Rate this result');
    voteGroup.append(voteButton('👍', 'Useful image', 1, result, card), voteButton('👎', 'Not relevant', -1, result, card));
    actions.append(voteGroup);
    body.append(actions);
    card.append(figure, body);
    return card;
  }

  function voteButton(symbol, label, rating, result, card) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `adaptive-vote-button ${rating > 0 ? 'is-upvote' : 'is-downvote'}`;
    button.dataset.keepText = 'true';
    button.textContent = symbol;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', () => saveVote(result, rating, button, card));
    return button;
  }

  async function saveVote(result, rating, button, card) {
    const key = `${result.imageUrl}:${rating}`;
    if (state.voting.has(key)) return;
    state.voting.add(key);
    button.disabled = true;
    try {
      const response = await fetch('/api/image-search/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: result.imageUrl,
          source: result.source,
          queryTerm: state.query,
          topic: state.keyword?.label || null,
          topicCluster: state.keyword?.keyword || null,
          rating,
          title: result.title || '',
          caption: result.caption || '',
          creator: result.creator || '',
          collection: result.collection || '',
          keywords: Array.isArray(result.significantKeywords) ? result.significantKeywords : []
        })
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Feedback could not be saved.');
      result.feedbackScore = Number(payload.score || 0);
      result.rankingScore = Number(result.rankingScore || 0) + rating * 1.4;
      card.dataset.feedbackScore = String(result.feedbackScore);
      card.dataset.rankingScore = String(result.rankingScore);
      card.classList.toggle('is-upvoted', rating > 0);
      card.classList.toggle('is-downvoted', rating < 0);
      updateFeedbackBadge(card, card.querySelector('[data-feedback-badge]'));
      resortRenderedCards();
      setStatus(`Feedback saved. Persistent score: ${formatSigned(result.feedbackScore)}. Similar images will be adjusted on refresh.`, 'success');
    } catch (error) {
      setStatus(error.message || 'Feedback could not be saved.', 'error');
    } finally {
      button.disabled = false;
      state.voting.delete(key);
    }
  }

  function updateFeedbackBadge(card, badge) {
    if (!badge) return;
    const score = Number(card.dataset.feedbackScore || 0);
    badge.hidden = score === 0;
    badge.textContent = score > 0 ? `+${score} feedback` : `${score} feedback`;
  }

  function resortRenderedCards() {
    const cards = [...elements.results.querySelectorAll('.adaptive-image-card')];
    cards.sort((a, b) => Number(b.dataset.rankingScore || 0) - Number(a.dataset.rankingScore || 0) || Number(a.dataset.providerRank || 0) - Number(b.dataset.providerRank || 0));
    for (const card of cards) elements.results.append(card);
  }

  function metadataItem(label, value) {
    const item = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = `${label}:`;
    item.append(strong, document.createTextNode(` ${value}`));
    return item;
  }

  function setLoading(loading, phase = '') {
    elements.submit.disabled = loading;
    elements.form.setAttribute('aria-busy', String(loading));
    panel.classList.toggle('is-loading', loading);
    panel.classList.toggle('is-extracting', loading && phase === 'extracting');
    panel.dataset.loadingPhase = loading ? phase : '';
  }

  function setStatus(message, type) {
    elements.status.textContent = message;
    elements.status.className = `status status-${type}`;
  }

  function sourceLabel(source) {
    return { wikimedia: 'Wikimedia Commons', openverse: 'Openverse', 'nlm-open-i': 'NLM Open-i' }[source] || source || 'Source';
  }

  function formatFilterMode(mode) {
    return { 'same-sentence': 'query and keyword in the same sentence', 'same-caption': 'query and keyword anywhere in the same caption', 'title-caption': 'query and keyword across title plus caption' }[mode] || mode || 'broad results';
  }

  function formatSigned(value) {
    const number = Number(value || 0);
    return number > 0 ? `+${number}` : String(number);
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { error: `The server returned an unexpected response (status ${response.status}).` }; }
  }
})();

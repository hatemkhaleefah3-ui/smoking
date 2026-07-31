'use strict';

(() => {
  const existingSearchForm = document.querySelector('#media-search-form');
  if (!existingSearchForm || document.querySelector('#adaptive-image-search')) return;

  const SESSION_DOWNVOTES_KEY = 'lecture-studio:image-search-downvotes';
  const panel = document.createElement('section');
  panel.id = 'adaptive-image-search';
  panel.className = 'adaptive-image-search panel';
  panel.setAttribute('aria-labelledby', 'adaptive-image-search-title');
  panel.innerHTML = `
    <header class="adaptive-image-search-heading">
      <div>
        <p class="step-kicker">Feedback-ranked multi-source search</p>
        <h3 id="adaptive-image-search-title">Search Wikimedia, Openverse and NLM Open-i.</h3>
        <p>Results improve as useful images are upvoted and unrelated images are downvoted.</p>
      </div>
      <span class="adaptive-learning-badge">Learns from feedback</span>
    </header>
    <form id="adaptive-image-search-form" class="adaptive-image-search-form" novalidate>
      <label for="adaptive-image-search-input">Search all free image sources</label>
      <div class="adaptive-image-search-command">
        <span class="adaptive-search-mark" aria-hidden="true"></span>
        <input id="adaptive-image-search-input" type="search" maxlength="160" autocomplete="off" placeholder="Try glycine, nephron anatomy, electron transport…">
        <button id="adaptive-image-search-submit" class="button button-primary" type="submit" aria-label="Search adaptive image sources">Search</button>
      </div>
    </form>
    <div id="adaptive-image-topic-panel" class="adaptive-image-topic-panel" hidden>
      <strong>Choose what you mean</strong>
      <p>Wikidata found more than one category.</p>
      <div id="adaptive-image-topic-options" class="adaptive-image-topic-options" role="group" aria-label="Search topic choices"></div>
    </div>
    <div class="adaptive-image-search-toolbar">
      <div id="adaptive-image-search-status" class="status status-neutral" role="status" aria-live="polite">Enter a term to search three live image sources.</div>
      <button id="adaptive-image-search-retry" class="button button-secondary" type="button" data-keep-text hidden>Retry without downvoted images</button>
    </div>
    <div id="adaptive-image-source-status" class="adaptive-image-source-status" hidden></div>
    <div id="adaptive-image-results" class="adaptive-image-results" hidden></div>
  `;
  existingSearchForm.insertAdjacentElement('afterend', panel);

  const elements = {
    form: panel.querySelector('#adaptive-image-search-form'),
    input: panel.querySelector('#adaptive-image-search-input'),
    submit: panel.querySelector('#adaptive-image-search-submit'),
    topicPanel: panel.querySelector('#adaptive-image-topic-panel'),
    topicOptions: panel.querySelector('#adaptive-image-topic-options'),
    retry: panel.querySelector('#adaptive-image-search-retry'),
    status: panel.querySelector('#adaptive-image-search-status'),
    sourceStatus: panel.querySelector('#adaptive-image-source-status'),
    results: panel.querySelector('#adaptive-image-results')
  };

  const state = {
    query: '',
    topic: null,
    results: [],
    downvotedUrls: loadSessionDownvotes(),
    voting: new Set()
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
    state.topic = null;
    runSearch({ retry: false });
  });

  elements.retry.addEventListener('click', () => {
    if (!state.query) return;
    runSearch({ retry: true });
  });

  async function runSearch({ retry, topic = state.topic } = {}) {
    setLoading(true);
    elements.topicPanel.hidden = true;
    elements.sourceStatus.hidden = true;
    elements.results.hidden = true;
    setStatus(retry ? 'Searching again without this session’s downvoted images…' : 'Checking Wikidata and searching live sources…', 'neutral');

    try {
      const response = await fetch('/api/image-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: state.query,
          topic,
          retry: Boolean(retry),
          excludeUrls: [...state.downvotedUrls]
        })
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || `Image search failed with status ${response.status}.`);

      if (payload.requiresTopic) {
        state.topic = null;
        renderTopicChoices(payload.topics || []);
        setStatus('Choose a topic before the image APIs are searched.', 'neutral');
        return;
      }

      state.topic = payload.topic || null;
      state.results = Array.isArray(payload.results) ? payload.results : [];
      renderSourceStatus(payload.sourceStatus || [], payload.cacheHit);
      renderResults(state.results);
      elements.retry.hidden = false;

      const topicText = payload.topic?.label ? ` for ${payload.topic.label}` : '';
      const cacheText = payload.cacheHit ? ' Cached metadata was ranked with current feedback.' : '';
      setStatus(`${state.results.length} result${state.results.length === 1 ? '' : 's'} found${topicText}.${cacheText}`, state.results.length ? 'success' : 'neutral');
    } catch (error) {
      setStatus(error.message || 'The adaptive image search failed.', 'error');
      elements.retry.hidden = !state.query;
    } finally {
      setLoading(false);
    }
  }

  function renderTopicChoices(topics) {
    elements.topicOptions.replaceChildren();
    for (const topic of topics.slice(0, 4)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'adaptive-topic-choice';
      button.dataset.keepText = 'true';
      button.textContent = topic.label || topic.id;
      button.addEventListener('click', () => {
        state.topic = topic;
        runSearch({ retry: false, topic });
      });
      elements.topicOptions.append(button);
    }
    elements.topicPanel.hidden = !elements.topicOptions.childElementCount;
  }

  function renderSourceStatus(items, cacheHit) {
    elements.sourceStatus.replaceChildren();
    if (cacheHit) {
      const cached = document.createElement('span');
      cached.className = 'is-cached';
      cached.textContent = '7-day metadata cache';
      elements.sourceStatus.append(cached);
    }
    for (const item of items) {
      const chip = document.createElement('span');
      chip.className = item.ok ? 'is-ready' : 'is-unavailable';
      chip.textContent = item.ok
        ? `${sourceLabel(item.source)} · ${Number(item.count || 0)}`
        : `${sourceLabel(item.source)} unavailable`;
      chip.title = item.error || '';
      elements.sourceStatus.append(chip);
    }
    elements.sourceStatus.hidden = !elements.sourceStatus.childElementCount;
  }

  function renderResults(results) {
    elements.results.replaceChildren();
    for (const result of results) elements.results.append(createResultCard(result));
    elements.results.hidden = !elements.results.childElementCount;
  }

  function createResultCard(result) {
    const card = document.createElement('article');
    card.className = 'adaptive-image-card';
    card.dataset.imageUrl = result.imageUrl || '';

    const figure = document.createElement('figure');
    const image = document.createElement('img');
    image.src = result.imageUrl;
    image.alt = result.caption || result.title || `${result.sourceLabel || 'Search'} result`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => card.classList.add('has-image-error'), { once: true });
    figure.append(image);

    const source = document.createElement('span');
    source.className = 'adaptive-image-source';
    source.textContent = result.sourceLabel || sourceLabel(result.source);
    figure.append(source);

    if (Number(result.feedbackScore || 0) > 0) {
      const learned = document.createElement('span');
      learned.className = 'adaptive-image-learned';
      learned.textContent = `+${result.feedbackScore} feedback`;
      figure.append(learned);
    }

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
    voteGroup.append(
      voteButton('👍', 'Useful image', 1, result, card),
      voteButton('👎', 'Not relevant', -1, result, card)
    );
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
    if (state.voting.has(key) || card.dataset.voted) return;
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
          topic: state.topic?.label || result.topic || null,
          rating
        })
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Feedback could not be saved.');

      card.dataset.voted = String(rating);
      card.classList.add(rating > 0 ? 'is-upvoted' : 'is-downvoted');
      card.querySelectorAll('.adaptive-vote-button').forEach((control) => { control.disabled = true; });

      if (rating < 0) {
        state.downvotedUrls.add(result.imageUrl);
        saveSessionDownvotes();
        window.setTimeout(() => {
          card.remove();
          if (!elements.results.childElementCount) elements.results.hidden = true;
        }, 260);
      }
    } catch (error) {
      button.disabled = false;
      setStatus(error.message || 'Feedback could not be saved.', 'error');
    } finally {
      state.voting.delete(key);
    }
  }

  function metadataItem(label, value) {
    const item = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = `${label}:`;
    item.append(strong, document.createTextNode(` ${value}`));
    return item;
  }

  function setLoading(loading) {
    elements.submit.disabled = loading;
    elements.form.setAttribute('aria-busy', String(loading));
    panel.classList.toggle('is-loading', loading);
  }

  function setStatus(message, type) {
    elements.status.textContent = message;
    elements.status.className = `status status-${type}`;
  }

  function sourceLabel(source) {
    return {
      wikimedia: 'Wikimedia Commons',
      openverse: 'Openverse',
      'nlm-open-i': 'NLM Open-i'
    }[source] || source || 'Source';
  }

  function loadSessionDownvotes() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_DOWNVOTES_KEY) || '[]');
      return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(-120) : []);
    } catch {
      return new Set();
    }
  }

  function saveSessionDownvotes() {
    try {
      sessionStorage.setItem(SESSION_DOWNVOTES_KEY, JSON.stringify([...state.downvotedUrls].slice(-120)));
    } catch {}
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { error: `The server returned an unexpected response (status ${response.status}).` };
    }
  }
})();

'use strict';

(() => {
  const primaryNav = document.querySelector('.primary-nav');
  const appMain = document.querySelector('#app-main');
  if (primaryNav && appMain && primaryNav.parentElement !== document.body) {
    primaryNav.classList.add('app-navigation');
    primaryNav.setAttribute('data-root-navigation', 'true');
    document.body.insertBefore(primaryNav, appMain);
  }

  const routePages = [...document.querySelectorAll('[data-route-page]')];
  const routeLinks = [...document.querySelectorAll('[data-route-link]')];
  const wizardPanels = [...document.querySelectorAll('[data-wizard-panel]')];
  const progressItems = [...document.querySelectorAll('[data-progress-step]')];
  const progressLabel = document.querySelector('#wizard-progress-label');
  const jsonContinueButton = document.querySelector('#json-continue-button');
  const mediaReadyPill = document.querySelector('#media-ready-pill');
  const makerShell = document.querySelector('.maker-shell');
  const routeNames = new Set(routePages.map((page) => page.dataset.routePage));
  const stepLabels = ['Introduction', 'Output', 'Canvas', 'Design', 'Source', 'Content', 'Media', 'Publish'];
  let activeWizardStep = 0;

  initializeRoutes();
  initializeWizard();
  initializeChoices();
  initializeSearchExamples();
  initializeLectureEvents();

  function initializeRoutes() {
    routeLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        const route = link.dataset.routeLink;
        if (!routeNames.has(route)) return;
        event.preventDefault();
        navigate(route);
        if (link.hasAttribute('data-wizard-start')) showWizardStep(0, false);
      });
    });
    window.addEventListener('hashchange', renderRoute);
    renderRoute();
  }

  function normalizeRoute() {
    const route = window.location.hash.replace(/^#/, '').trim().toLowerCase();
    return routeNames.has(route) ? route : 'home';
  }

  function navigate(route) {
    if (!routeNames.has(route)) route = 'home';
    if (normalizeRoute() === route && window.location.hash) {
      renderRoute();
      return;
    }
    window.location.hash = route;
  }

  function renderRoute() {
    const route = normalizeRoute();
    routePages.forEach((page) => {
      const active = page.dataset.routePage === route;
      page.hidden = !active;
      page.setAttribute('aria-hidden', String(!active));
    });
    routeLinks.forEach((link) => {
      const active = link.dataset.routeLink === route;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.body.dataset.route = route;
    const titles = {
      home: 'Lecture Studio',
      maker: 'Lecture Maker · Lecture Studio',
      search: 'Search · Lecture Studio',
      extractor: 'Extractor · Lecture Studio'
    };
    document.title = titles[route] || titles.home;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function initializeWizard() {
    document.addEventListener('click', (event) => {
      const control = event.target.closest('[data-wizard-go]');
      if (!control || control.disabled) return;
      const step = Number(control.dataset.wizardGo);
      if (!Number.isInteger(step)) return;
      showWizardStep(step);
    });

    document.querySelector('[data-new-project]')?.addEventListener('click', () => {
      window.location.hash = 'maker';
      window.location.reload();
    });

    showWizardStep(0, false);
  }

  function showWizardStep(step, focus = true) {
    const next = Math.max(0, Math.min(7, Number(step) || 0));
    activeWizardStep = next;
    wizardPanels.forEach((panel) => {
      const active = Number(panel.dataset.wizardPanel) === next;
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    });
    progressItems.forEach((item) => {
      const itemStep = Number(item.dataset.progressStep);
      item.classList.toggle('is-current', itemStep === next);
      item.classList.toggle('is-complete', itemStep < next);
    });
    if (progressLabel) progressLabel.textContent = stepLabels[next] || 'Project flow';
    document.body.dataset.wizardStep = String(next);
    if (focus) {
      makerShell?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => wizardPanels.find((panel) => !panel.hidden)?.querySelector('h2')?.focus?.(), 250);
    }
  }

  function initializeChoices() {
    const groups = [
      ['input[name="output-type"]', '.choice-card'],
      ['input[name="page-format"]', '.dimension-card'],
      ['input[name="source-type"]', '.source-card'],
      ['input[name="design"]', '.design-option']
    ];

    for (const [selector, cardSelector] of groups) {
      const inputs = [...document.querySelectorAll(selector)];
      const sync = () => {
        inputs.forEach((input) => {
          const card = input.closest(cardSelector);
          if (!card) return;
          card.classList.toggle('is-selected', input.checked);
          const state = card.querySelector('.choice-state, .selection-badge');
          if (state && !input.disabled) state.textContent = input.checked ? 'Selected' : 'Select';
        });
        updateSummaryChoice();
      };
      inputs.forEach((input) => input.addEventListener('change', sync));
      sync();
    }
  }

  function updateSummaryChoice() {
    const designInput = document.querySelector('input[name="design"]:checked');
    const formatInput = document.querySelector('input[name="page-format"]:checked');
    const designName = designInput?.closest('.design-option')?.querySelector('.design-name')?.textContent?.trim() || 'Classic Academic';
    const formatNames = { free: 'Free canvas', a4: 'A4 page', slide: 'PPTX slide' };
    const summary = document.querySelector('#summary-design-name');
    if (summary) summary.textContent = `${designName} · ${formatNames[formatInput?.value] || 'Free canvas'}`;
  }

  function initializeSearchExamples() {
    const input = document.querySelector('#media-search-input');
    document.querySelectorAll('[data-search-example]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!input) return;
        input.value = button.dataset.searchExample || '';
        input.focus();
      });
    });
  }

  function initializeLectureEvents() {
    document.querySelector('#file-input')?.addEventListener('change', () => {
      if (jsonContinueButton) jsonContinueButton.disabled = true;
      if (mediaReadyPill) mediaReadyPill.textContent = 'Validating JSON';
    });

    window.addEventListener('lecture:built', (event) => {
      if (jsonContinueButton) jsonContinueButton.disabled = false;
      const imageCount = Number(event.detail?.imageCount || 0);
      if (mediaReadyPill) mediaReadyPill.textContent = imageCount ? `${imageCount} image labels found` : 'No images required';
    });

    window.addEventListener('lecture:build-failed', () => {
      if (jsonContinueButton) jsonContinueButton.disabled = true;
      if (mediaReadyPill) mediaReadyPill.textContent = 'JSON needs attention';
    });

    window.addEventListener('lecture:images-updated', (event) => {
      if (!mediaReadyPill) return;
      const ready = Number(event.detail?.ready || 0);
      const total = Number(event.detail?.total || 0);
      mediaReadyPill.textContent = `${ready} of ${total} images ready`;
      mediaReadyPill.classList.toggle('is-ready', total === 0 || ready === total);
    });

    window.addEventListener('lecture:published', () => showWizardStep(7));
  }

  function getSettings() {
    return {
      outputType: document.querySelector('input[name="output-type"]:checked')?.value || 'website',
      pageFormat: document.querySelector('input[name="page-format"]:checked')?.value || 'free',
      designId: document.querySelector('input[name="design"]:checked')?.value || 'classic',
      sourceType: document.querySelector('input[name="source-type"]:checked')?.value || 'json'
    };
  }

  window.LectureStudioShell = {
    navigate,
    showWizardStep,
    getSettings,
    get activeWizardStep() { return activeWizardStep; }
  };

  const integrationScript = document.createElement('script');
  integrationScript.src = 'studio-integration.js';
  integrationScript.async = false;
  document.head.append(integrationScript);

  const refinementScript = document.createElement('script');
  refinementScript.src = 'studio-refinements.js';
  refinementScript.async = false;
  document.head.append(refinementScript);

  // Dynamic Theme Switcher Logic
  const themeButtons = document.querySelectorAll('.theme-btn');
  const savedTheme = localStorage.getItem('lecture-studio-theme') || 'light';

  function applyTheme(themeId) {
    document.body.dataset.theme = themeId;
    localStorage.setItem('lecture-studio-theme', themeId);
    themeButtons.forEach((btn) => {
      const active = btn.dataset.themeId === themeId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  themeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.themeId);
    });
  });

  applyTheme(savedTheme);

  const iconScrollScript = document.createElement('script');
  iconScrollScript.src = 'icon-scroll-system.js';
  iconScrollScript.async = false;
  document.head.append(iconScrollScript);
})();

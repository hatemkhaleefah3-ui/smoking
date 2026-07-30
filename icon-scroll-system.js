'use strict';

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    home: ['M3 11.5 12 4l9 7.5', 'M5.5 10.5V20h13v-9.5', 'M9.5 20v-6h5v6'],
    maker: ['M5 4.5h10l4 4V20H5z', 'M15 4.5V9h4', 'M8 13h8', 'M8 16h6'],
    search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z', 'm16.5 16.5 4 4'],
    extractor: ['M6 3.5h9l3 3V13', 'M15 3.5V7h3', 'M12 11v9', 'm8.5 16.5 3.5 3.5 3.5-3.5'],
    play: ['M8 5.5v13l10-6.5z'],
    plus: ['M12 5v14', 'M5 12h14'],
    arrowRight: ['M5 12h14', 'm14 6 6 6-6 6'],
    arrowLeft: ['M19 12H5', 'm10-6-6 6 6 6'],
    refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M18.4 9A7 7 0 0 0 6.8 6.8L4 9', 'M5.6 15A7 7 0 0 0 17.2 17.2L20 15'],
    save: ['M5 4h12l2 2v14H5z', 'M8 4v6h8V4', 'M8 15h8v5H8z'],
    copy: ['M8 8h11v12H8z', 'M5 16H4V4h11v1'],
    eye: ['M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
    upload: ['M12 16V4', 'm7.5 8.5 4.5-4.5 4.5 4.5', 'M5 15v5h14v-5'],
    download: ['M12 4v12', 'm7.5 11.5 4.5 4.5 4.5-4.5', 'M5 20h14'],
    sparkles: ['m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z', 'm18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7z', 'm5 14 .7 1.8 1.8.7-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7z'],
    check: ['m5 12 4 4L19 6'],
    close: ['m6 6 12 12', 'M18 6 6 18'],
    retry: ['M19 7v5h-5', 'M19 12a7 7 0 1 1-2-5'],
    newProject: ['M12 3v18', 'M3 12h18'],
    more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01']
  };

  const TRACKS = [
    ['.workspace-grid', 'card'],
    ['.process-list', 'card'],
    ['.instruction-grid', 'card'],
    ['.choice-grid', 'card'],
    ['.dimension-grid', 'dimension'],
    ['.design-picker', 'design'],
    ['.source-grid', 'card'],
    ['.image-import-list', 'wide'],
    ['.image-candidate-viewport', 'image'],
    ['.media-results-grid', 'image'],
    ['.summary-stats', 'compact'],
    ['.hero-proof', 'compact'],
    ['.search-suggestions', 'compact'],
    ['.pdf-extractor-grid', 'utility'],
    ['.document-details dl', 'compact']
  ];

  const CONTROL_SELECTOR = [
    'button',
    'a.button',
    '.topbar-action',
    '.brand',
    '.primary-nav a',
    '.footer-inner nav a',
    '.image-file-button',
    '.drop-button',
    '.image-candidate-action'
  ].join(',');

  function createIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('control-icon');
    for (const pathData of ICON_PATHS[name] || ICON_PATHS.more) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.8');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    }
    return svg;
  }

  function visibleLabel(control) {
    const explicit = control.getAttribute('aria-label') || control.getAttribute('title');
    if (explicit) return explicit.trim();
    const clone = control.cloneNode(true);
    clone.querySelectorAll('.control-icon, .sr-only').forEach((node) => node.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim() || 'Action';
  }

  function iconFor(control, label) {
    const route = control.dataset.routeLink;
    if (control.classList.contains('brand')) return 'home';
    if (route === 'home') return 'home';
    if (route === 'maker') return 'maker';
    if (route === 'search') return 'search';
    if (route === 'extractor') return 'extractor';

    const key = `${control.id} ${control.className} ${label}`.toLowerCase();
    if (/back|previous|arrow-left/.test(key)) return 'arrowLeft';
    if (/continue|next|publish|arrow-right/.test(key)) return 'arrowRight';
    if (/search|find|lookup/.test(key)) return 'search';
    if (/refresh|reload|again/.test(key)) return 'refresh';
    if (/retry/.test(key)) return 'retry';
    if (/save|select|choose|confirm|apply/.test(key)) return 'check';
    if (/copy/.test(key)) return 'copy';
    if (/preview|view|open/.test(key)) return 'eye';
    if (/extract|download/.test(key)) return 'download';
    if (/upload|import|drop|file/.test(key)) return 'upload';
    if (/build|create lecture|generate|prepare/.test(key)) return 'sparkles';
    if (/start|play|begin/.test(key)) return 'play';
    if (/new project|add|replace/.test(key)) return 'plus';
    if (/close|remove|cancel|delete/.test(key)) return 'close';
    return 'more';
  }

  function iconize(control) {
    if (!(control instanceof HTMLElement) || control.dataset.iconized === 'true') return;
    if (control.matches('[data-keep-text], [aria-hidden="true"]')) return;
    if (control.closest('.workspace-card, .process-list') && !control.matches('button, a.button')) return;

    const label = visibleLabel(control);
    const iconName = iconFor(control, label);
    const hiddenLabel = document.createElement('span');
    hiddenLabel.className = 'sr-only control-label';
    hiddenLabel.textContent = label;

    control.replaceChildren(createIcon(iconName), hiddenLabel);
    control.classList.add('icon-only-control');
    if (control.matches('.primary-nav a, .footer-inner nav a')) control.classList.add('icon-nav-control');
    control.dataset.iconized = 'true';
    control.dataset.icon = iconName;
    control.setAttribute('aria-label', label);
    if (!control.hasAttribute('title')) control.setAttribute('title', label);
  }

  function applyControls(root = document) {
    if (root instanceof Element && root.matches(CONTROL_SELECTOR)) iconize(root);
    root.querySelectorAll?.(CONTROL_SELECTOR).forEach(iconize);
  }

  function trackLabel(element) {
    if (element.classList.contains('workspace-grid')) return 'Workspace cards';
    if (element.classList.contains('design-picker')) return 'Lecture designs';
    if (element.classList.contains('dimension-grid')) return 'Page dimensions';
    if (element.classList.contains('source-grid')) return 'Content sources';
    if (element.classList.contains('image-import-list')) return 'Lecture image labels';
    if (element.classList.contains('image-candidate-viewport')) return 'Image choices';
    if (element.classList.contains('media-results-grid')) return 'Search images';
    return 'Scrollable choices';
  }

  function makeTrack(element, kind) {
    if (!(element instanceof HTMLElement) || element.dataset.slideTrack === 'true') return;
    element.dataset.slideTrack = 'true';
    element.dataset.slideKind = kind;
    element.classList.add('horizontal-slide-track');
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'region');
    if (!element.hasAttribute('aria-label')) element.setAttribute('aria-label', trackLabel(element));
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      element.scrollBy({ left: direction * Math.max(220, element.clientWidth * 0.82), behavior: 'smooth' });
    });
  }

  function applyTracks(root = document) {
    for (const [selector, kind] of TRACKS) {
      if (root instanceof Element && root.matches(selector)) makeTrack(root, kind);
      root.querySelectorAll?.(selector).forEach((element) => makeTrack(element, kind));
    }
  }

  function initialize(root = document) {
    applyControls(root);
    applyTracks(root);
  }

  initialize();

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) initialize(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  window.IconScrollSystem = { initialize, applyControls, applyTracks };
})();

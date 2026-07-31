'use strict';

(() => {
  const heroActions = document.querySelector('.hero-actions');
  const firstHomeSection = document.querySelector('.home-section');

  if (firstHomeSection) firstHomeSection.id = 'home-details';

  if (heroActions) {
    const knowMore = document.createElement('button');
    knowMore.type = 'button';
    knowMore.className = 'button button-primary button-large home-know-more';
    knowMore.dataset.keepText = 'true';
    knowMore.textContent = 'Know more';
    knowMore.addEventListener('click', () => {
      firstHomeSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    heroActions.replaceChildren(knowMore);
  }

  const suggestionLabels = ['Glycine pathway', 'Nephron anatomy', 'Electron transport'];
  document.querySelectorAll('[data-search-example]').forEach((button, index) => {
    button.dataset.keepText = 'true';
    button.replaceChildren(suggestionLabels[index] || 'Search example');
  });

  preserveNumberLabels(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) preserveNumberLabels(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const preview = document.querySelector('.preview-visual');
  if (preview) preview.setAttribute('aria-label', 'Glycine oxidation pathway diagram');

  const adaptiveSearchScript = document.createElement('script');
  adaptiveSearchScript.src = 'adaptive-image-search.js';
  adaptiveSearchScript.async = false;
  document.head.append(adaptiveSearchScript);

  function preserveNumberLabels(root) {
    if (root instanceof Element && root.matches('.pdf-number-choice')) root.dataset.keepText = 'true';
    root.querySelectorAll?.('.pdf-number-choice').forEach((button) => {
      button.dataset.keepText = 'true';
    });
  }
})();

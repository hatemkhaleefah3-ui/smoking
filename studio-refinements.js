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

  document.querySelectorAll('.pdf-number-choice').forEach((button) => {
    button.dataset.keepText = 'true';
  });

  const preview = document.querySelector('.preview-visual');
  if (preview) preview.setAttribute('aria-label', 'Glycine oxidation pathway diagram');
})();

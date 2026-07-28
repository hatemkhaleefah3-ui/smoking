'use strict';

const DESIGNS = {
  classic: 'templates/lecture-template.html',
  enhanced: 'templates/lecture-template-enhanced.html',
  editorial: 'templates/lecture-template-editorial.html',
  clinical: 'templates/lecture-template-clinical.html'
};

loadPublishedLecture();

async function loadPublishedLecture() {
  const id = getLectureId();
  if (!id) return showError('Invalid lecture link', 'This address does not contain a lecture ID.');

  try {
    const response = await fetch(`/api/lectures/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (response.status === 404) return showError('Lecture unavailable', 'This lecture link has been removed or does not exist.');
    if (!response.ok) throw new Error('The lecture service returned an error.');

    const storedData = await response.json();
    const designId = storedData?._design === 'clinical' ? 'clinical' : response.headers.get('X-Design-Id') || 'classic';
    if (!DESIGNS[designId]) throw new Error('The saved lecture uses an unsupported design.');
    const data = LectureRenderer.normalize(storedData);
    const templateResponse = await fetch(`/${DESIGNS[designId]}`, { cache: 'no-store' });
    if (!templateResponse.ok) throw new Error('The lecture design could not be loaded.');
    const html = LectureRenderer.render(data, await templateResponse.text(), designId);

    document.open();
    document.write(html);
    document.close();
  } catch (error) {
    showError('Could not open lecture', error.message);
  }
}

function getLectureId() {
  const pathMatch = location.pathname.match(/^\/lecture\/([0-9a-f-]{36})\/?$/i);
  return pathMatch?.[1] || new URLSearchParams(location.search).get('id') || '';
}

function showError(title, message) {
  const state = document.querySelector('#lecture-state');
  state.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  const link = document.createElement('a');
  link.href = '/';
  link.textContent = 'Return to Lecture Publisher';
  state.append(heading, paragraph, link);
  document.title = title;
}

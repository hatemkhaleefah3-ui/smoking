'use strict';

const elements = {
  loginPanel: document.querySelector('#login-panel'),
  loginForm: document.querySelector('#login-form'),
  password: document.querySelector('#password'),
  loginStatus: document.querySelector('#login-status'),
  dashboard: document.querySelector('#dashboard'),
  dashboardStatus: document.querySelector('#dashboard-status'),
  logout: document.querySelector('#logout-button'),
  refresh: document.querySelector('#refresh-button'),
  used: document.querySelector('#used-storage'),
  percent: document.querySelector('#usage-percent'),
  count: document.querySelector('#lecture-count'),
  oldest: document.querySelector('#oldest-lecture'),
  allowance: document.querySelector('#storage-allowance'),
  progress: document.querySelector('#progress-fill'),
  search: document.querySelector('#search-input'),
  sort: document.querySelector('#sort-select'),
  rows: document.querySelector('#lecture-rows'),
  previous: document.querySelector('#previous-button'),
  next: document.querySelector('#next-button'),
  pageLabel: document.querySelector('#page-label'),
  cleanupButtons: [...document.querySelectorAll('[data-cleanup]')]
};

const state = { page: 1, pageSize: 25, total: 0, search: '', sort: 'newest' };
let searchTimer;

initialize();

async function initialize() {
  bindEvents();
  try {
    const response = await fetch('/api/admin/session', { cache: 'no-store' });
    if (response.ok) await showDashboard();
  } catch { /* login remains visible */ }
}

function bindEvents() {
  elements.loginForm.addEventListener('submit', login);
  elements.logout.addEventListener('click', logout);
  elements.refresh.addEventListener('click', refreshDashboard);
  elements.cleanupButtons.forEach((button) => button.addEventListener('click', () => cleanup(Number(button.dataset.cleanup))));
  elements.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = elements.search.value.trim(); state.page = 1; loadLectures(); }, 250);
  });
  elements.sort.addEventListener('change', () => { state.sort = elements.sort.value; state.page = 1; loadLectures(); });
  elements.previous.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadLectures(); } });
  elements.next.addEventListener('click', () => { if (state.page * state.pageSize < state.total) { state.page += 1; loadLectures(); } });
}

async function login(event) {
  event.preventDefault();
  setMessage(elements.loginStatus, 'Signing in…');
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: elements.password.value })
    });
    const result = await readJson(response);
    if (!response.ok) return setMessage(elements.loginStatus, result.error || `Sign-in failed with status ${response.status}.`, 'error');
    elements.password.value = '';
    await showDashboard();
  } catch (error) {
    setMessage(elements.loginStatus, error.message || 'The admin service could not be reached.', 'error');
  }
}

async function logout() {
  await fetch('/api/admin/logout', { method: 'POST' });
  elements.dashboard.hidden = true;
  elements.loginPanel.hidden = false;
  setMessage(elements.loginStatus, 'Signed out.', 'success');
}

async function showDashboard() {
  elements.loginPanel.hidden = true;
  elements.dashboard.hidden = false;
  await refreshDashboard();
}

async function refreshDashboard() {
  setMessage(elements.dashboardStatus, 'Refreshing…');
  try {
    await Promise.all([loadStorage(), loadLectures()]);
    setMessage(elements.dashboardStatus, 'Dashboard updated.', 'success');
  } catch (error) {
    if (error.message === 'UNAUTHORIZED') return logout();
    setMessage(elements.dashboardStatus, error.message, 'error');
  }
}

async function loadStorage() {
  const response = await fetch('/api/admin/storage', { cache: 'no-store' });
  const result = await readJson(response);
  ensureAuthorized(response);
  if (!response.ok) throw new Error(result.error || 'Could not load storage information.');
  elements.used.textContent = formatBytes(result.totalBytes);
  elements.percent.textContent = `${result.usagePercent.toFixed(2)}% of tracked allowance`;
  elements.count.textContent = result.lectureCount.toLocaleString();
  elements.oldest.textContent = result.oldestCreatedAt ? `Oldest: ${formatDate(result.oldestCreatedAt)}` : 'No stored lectures';
  elements.allowance.textContent = formatBytes(result.allowanceBytes);
  elements.progress.style.width = `${Math.min(100, result.usagePercent)}%`;
}

async function loadLectures() {
  const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize, sort: state.sort });
  if (state.search) params.set('search', state.search);
  const response = await fetch(`/api/admin/lectures?${params}`, { cache: 'no-store' });
  const result = await readJson(response);
  ensureAuthorized(response);
  if (!response.ok) throw new Error(result.error || 'Could not load lectures.');
  state.total = result.total;
  renderRows(result.items);
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  elements.pageLabel.textContent = `Page ${state.page} of ${totalPages} · ${state.total} lectures`;
  elements.previous.disabled = state.page <= 1;
  elements.next.disabled = state.page >= totalPages;
}

function renderRows(items) {
  elements.rows.replaceChildren();
  if (items.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No published lectures found.';
    row.append(cell);
    elements.rows.append(row);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('tr');
    row.append(cell(item.title), cell(designName(item.designId)), cell(formatBytes(item.sizeBytes)), cell(formatDate(item.createdAt)));

    const linkCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open';
    linkCell.append(link);

    const actionCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyLink(item.url));
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => deleteLecture(item));
    actions.append(copy, remove);
    actionCell.append(actions);
    row.append(linkCell, actionCell);
    elements.rows.append(row);
  });
}

async function deleteLecture(item) {
  if (!confirm(`Delete “${item.title}”?\n\nIts public link will stop working and the action cannot be undone.`)) return;
  const response = await fetch(`/api/admin/lectures/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
  const result = await readJson(response);
  ensureAuthorized(response);
  if (!response.ok) return setMessage(elements.dashboardStatus, result.error || 'Delete failed.', 'error');
  setMessage(elements.dashboardStatus, `Deleted “${result.title}” and freed ${formatBytes(result.freedBytes)}.`, 'success');
  await refreshDashboard();
}

async function cleanup(percentage) {
  let confirmed;
  if (percentage === 100) {
    confirmed = prompt('This permanently removes every lecture link. Type DELETE ALL to continue:') === 'DELETE ALL';
  } else {
    confirmed = confirm(`Delete the oldest lectures until at least ${percentage}% of the currently stored bytes are freed?\n\nDeleted public links will stop working.`);
  }
  if (!confirmed) return;
  setMessage(elements.dashboardStatus, 'Cleanup in progress…');
  toggleCleanup(true);
  try {
    const response = await fetch('/api/admin/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage })
    });
    const result = await readJson(response);
    ensureAuthorized(response);
    if (!response.ok) throw new Error(result.error || 'Cleanup failed.');
    setMessage(elements.dashboardStatus, `Deleted ${result.deletedLectures} lectures and freed ${formatBytes(result.freedBytes)}.`, 'success');
    state.page = 1;
    await refreshDashboard();
  } catch (error) {
    setMessage(elements.dashboardStatus, error.message, 'error');
  } finally {
    toggleCleanup(false);
  }
}

async function copyLink(url) {
  try { await navigator.clipboard.writeText(url); setMessage(elements.dashboardStatus, 'Lecture link copied.', 'success'); }
  catch { setMessage(elements.dashboardStatus, url); }
}

function cell(text) { const output = document.createElement('td'); output.textContent = text; return output; }
function designName(id) { return ({ classic: 'Classic Academic', enhanced: 'Enhanced Modern', editorial: 'Editorial Journal' })[id] || id; }
function ensureAuthorized(response) { if (response.status === 401) throw new Error('UNAUTHORIZED'); }
function toggleCleanup(disabled) { elements.cleanupButtons.forEach((button) => { button.disabled = disabled; }); }
function setMessage(element, message, type = '') { element.textContent = message; element.className = `message ${type}`.trim(); }
async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { error: text.trim().slice(0, 300) || `Request failed with status ${response.status}.` }; }
}
function formatBytes(bytes) { const value = Number(bytes) || 0; if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(2)} MB`; return `${(value / 1024 ** 3).toFixed(2)} GB`; }
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }

const byId = id => document.getElementById(id);
const form = byId('investigate-form');
const repoInput = byId('repository');
const userInput = byId('username');
const runButton = byId('run-button');
const historyButton = byId('history-button');
const inboxButton = byId('inbox-button');
const recheck = byId('recheck-button');
const savedSelect = byId('saved-inboxes');
const replay = byId('replay-button');
const report = byId('report');
const reportHeading = byId('report-heading');
const list = byId('promise-list');
const detail = byId('case');
const statusBar = byId('status');
const errorBox = byId('error');
const about = byId('about');
const badges = { evidence: 'Matching merge', review: 'Needs review', open: 'No match yet' };
const sourceNames = {
  history: 'Public GitHub history',
  'github-connector': 'GitHub via a Sprites Connector',
  'github-direct': 'Public GitHub API',
};
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const targetKey = target => target.repo.toLowerCase() + '@' + target.username.toLowerCase();
const narrow = matchMedia('(max-width: 650px)');
let lastResult;
let selectedId;
let inboxes = [];
let busy = false;

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
}

function dateLabel(date) {
  return date && Number.isFinite(Date.parse(date)) ? dateFormat.format(new Date(date)) : '';
}

function setStatus(kind, message) {
  statusBar.className = 'status ' + kind;
  statusBar.textContent = message;
}

function source(label, url) {
  if (!url) return element('strong', '', label);
  const link = element('a', 'source-link', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function renderTimeline(entries) {
  const timeline = element('ol', 'timeline');
  for (const entry of entries) {
    const row = element('li', entry.confirmed ? 'confirmed' : '');
    row.append(source(entry.label, entry.url), element('p', 'evidence-text', entry.text));
    if (entry.excerpt) row.append(element('p', 'excerpt', entry.excerpt));
    if (entry.reason) row.append(element('p', 'reason', entry.reason));
    if (dateLabel(entry.date)) {
      const date = element('time', '', dateLabel(entry.date));
      date.dateTime = entry.date;
      row.append(date);
    }
    timeline.append(row);
  }
  return timeline;
}

function renderDraft(text) {
  const draft = element('div', 'draft');
  const field = element('textarea');
  field.setAttribute('aria-labelledby', 'draft-heading');
  field.readOnly = true;
  field.rows = 2;
  field.value = text;

  const controls = element('div', 'draft-controls');
  const copy = element('button', 'button quiet', 'Copy follow-up');
  copy.type = 'button';
  const feedback = element('p', 'copy-feedback');
  feedback.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      feedback.textContent = 'Follow-up copied.';
    } catch {
      field.focus();
      field.select();
      feedback.textContent = 'Follow-up selected. Use your device’s Copy command.';
    }
  });
  controls.append(copy, feedback);
  draft.append(field, controls);
  return draft;
}

function renderCase(result, promise, focus = false) {
  selectedId = promise.id;
  let selectedButton;
  for (const button of list.querySelectorAll('button')) {
    if (button.dataset.promise === selectedId) {
      button.setAttribute('aria-current', 'true');
      selectedButton = button;
    } else {
      button.removeAttribute('aria-current');
    }
  }

  const back = element('button', 'text-button back-to-promises', 'Back to promises');
  back.type = 'button';
  back.addEventListener('click', () => selectedButton?.focus());
  const heading = element('h3', 'case-heading', promise.task);
  heading.id = 'case-heading';
  heading.tabIndex = -1;

  const quote = element('blockquote', 'original');
  const author = element('footer', 'quote-author');
  author.append(result.username + ' in ', source(promise.parentLabel, promise.url));
  if (dateLabel(promise.date)) author.append(', ' + dateLabel(promise.date));
  quote.append(element('p', '', '“' + promise.quote + '”'), author);

  const draftHeading = element('h4', '', 'Suggested follow-up');
  draftHeading.id = 'draft-heading';
  const details = [heading, back];
  if (promise.change === 'status') {
    details.push(element('p', 'status-change', 'Changed from ' + badges[promise.previousStatus].toLowerCase()
      + ' to ' + badges[promise.status].toLowerCase() + '.'));
  }
  if (!promise.observed && promise.lastCheckedAt) {
    details.push(element('p', 'muted saved-note', 'Last checked ' + dateLabel(promise.lastCheckedAt) + '.'));
  }
  detail.replaceChildren(...details, element('h4', '', 'Original promise'), quote,
    element('h4', '', 'Evidence timeline'), renderTimeline(promise.evidence), draftHeading, renderDraft(promise.draft));

  if (focus && narrow.matches) heading.focus();
}

function renderInboxPicker(result, historical) {
  byId('saved-target').hidden = historical || inboxes.length < 2;
  savedSelect.replaceChildren(...inboxes.map(item => {
    const option = element('option', '', item.repo + ' for @' + item.username);
    option.value = targetKey(item);
    return option;
  }));
  if (result && !historical) savedSelect.value = targetKey(result);
}

function renderResult(result, focus = false) {
  const previous = lastResult;
  lastResult = result;
  const historical = result?.source === 'history';
  const sameTarget = result && previous?.source === result.source && targetKey(previous) === targetKey(result);
  byId('report-header').hidden = false;
  reportHeading.textContent = historical ? 'Merge replay' : 'Follow-up inbox';
  byId('report-target').textContent = result ? result.repo + ' for @' + result.username : '';
  renderInboxPicker(result, historical);

  const count = result?.promises.length ?? 0;
  report.hidden = count === 0;
  byId('empty').hidden = count > 0;
  byId('empty-message').textContent = result
    ? 'No promises found for this username in the records checked.'
    : 'Run an investigation to start tracking your commitments.';
  byId('report-footer').hidden = !result;
  recheck.hidden = historical || !result;
  inboxButton.hidden = !historical;
  replay.hidden = !historical;
  replay.textContent = result?.stage === 'after' ? 'Replay from the start' : 'Next scan';
  if (!result) {
    setStatus('done', '');
    if (focus) reportHeading.focus();
    return;
  }

  if (historical) {
    setStatus('done', (result.stage === 'after' ? 'After merge' : 'Before merge') + ', '
      + timeFormat.format(new Date(result.scannedAt)) + (result.changed ? '. 1 promise changed.' : '.'));
  } else {
    const revised = result.promises.filter(item => item.change === 'evidence').length;
    const changes = [];
    if (result.changed) changes.push(result.changed + (result.changed === 1 ? ' status changed' : ' statuses changed'));
    if (revised) changes.push(revised + (revised === 1 ? ' promise has' : ' promises have') + ' new evidence');
    if (result.added) changes.push(result.added + (result.added === 1 ? ' new promise' : ' new promises'));
    const summary = changes.length ? changes.join(', ') + '.' : 'No changes in this scan.';
    setStatus('done', summary + ' Last checked ' + timeFormat.format(new Date(result.scannedAt)) + '.');
  }

  const { issues, comments, pulls, followed } = result.scanned;
  byId('scan-source').textContent = sourceNames[result.source];
  byId('scan-scope').hidden = historical;
  byId('scan-scope').textContent = 'Scanned ' + issues + ' issues, ' + comments + ' comments, ' + pulls + ' pull requests'
    + (followed ? ', and ' + followed + ' follow-up lookups.' : '.');

  list.replaceChildren(...result.promises.map(promise => {
    const row = element('li');
    const button = element('button', 'promise');
    button.type = 'button';
    button.dataset.promise = promise.id;
    const meta = element('span', 'promise-meta');
    meta.append(element('span', 'row-location', promise.parentLabel),
      element('span', 'badge ' + promise.status, badges[promise.status]));
    if (promise.change === 'status' || promise.change === 'evidence') {
      const label = promise.change === 'status' ? 'Status changed' : 'New evidence';
      meta.append(element('span', 'row-change', label));
    }
    button.append(element('span', 'promise-title', promise.task), meta);
    button.addEventListener('click', () => renderCase(result, promise, true));
    row.append(button);
    return row;
  }));
  const changed = result.promises.find(item => item.change === 'status' || item.change === 'evidence');
  const next = changed || (sameTarget && result.promises.find(promise => promise.id === selectedId)) || result.promises[0];
  if (next) renderCase(result, next);
  if (focus) reportHeading.focus();
}

async function loadReport(path, { input, focus = false, loading = 'Loading the inbox.' } = {}) {
  if (busy) return;
  busy = true;
  const controls = [runButton, historyButton, inboxButton, recheck, replay];
  for (const button of controls) button.setAttribute('aria-disabled', 'true');
  savedSelect.disabled = true;
  form.setAttribute('aria-busy', 'true');
  errorBox.hidden = true;
  errorBox.textContent = '';
  setStatus('working', loading);
  try {
    const response = await fetch(path, {
      method: input ? 'POST' : 'GET',
      headers: input ? { 'Content-Type': 'application/json' } : {},
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(35_000),
    });
    const data = await response.json();
    if (!response.ok) {
      errorBox.textContent = data.error;
      throw new Error('request failed');
    }
    if (data.inboxes) inboxes = data.inboxes;
    renderResult(data.report === undefined ? data : data.report, focus);
  } catch {
    setStatus('failed', lastResult ? 'Investigation paused. Showing the previous report.' : 'Investigation paused.');
    errorBox.textContent ||= 'Ghostlight couldn’t reach the server. Try again in a moment.';
    errorBox.hidden = false;
  } finally {
    form.removeAttribute('aria-busy');
    for (const button of controls) button.removeAttribute('aria-disabled');
    savedSelect.disabled = false;
    busy = false;
  }
}

function investigate(input, focus = false) {
  return loadReport('/api/investigate', { input, focus, loading: 'Reading GitHub threads and checking for new evidence.' });
}

function showInbox(item, focus = false) {
  const query = item ? '?' + new URLSearchParams({ repo: item.repo, username: item.username }) : '';
  return loadReport('/api/inbox' + query, { focus });
}

function showHistory(stage, focus = false) {
  return loadReport('/api/replay?stage=' + stage, { focus, loading: 'Loading the GitHub timeline.' });
}

async function configureRepository() {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const { allowedRepo } = await response.json();
    if (!allowedRepo || repoInput.value) return;
    repoInput.value = allowedRepo;
    repoInput.readOnly = true;
    repoInput.setAttribute('aria-describedby', 'repo-scope');
    const scope = byId('repo-scope');
    scope.textContent = 'GitHub access is scoped to this repository.';
    scope.hidden = false;
  } catch {
    // The investigation endpoint reports connection errors on submit.
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  investigate({ repo: repoInput.value.trim(), username: userInput.value.trim() }, true);
});
historyButton.addEventListener('click', () => showHistory('before', true));
replay.addEventListener('click', () => showHistory(lastResult?.stage === 'before' ? 'after' : 'before'));
inboxButton.addEventListener('click', () => showInbox(undefined, true));
recheck.addEventListener('click', () => {
  if (lastResult && lastResult.source !== 'history') investigate({ repo: lastResult.repo, username: lastResult.username });
});
savedSelect.addEventListener('change', () => {
  const item = inboxes.find(entry => targetKey(entry) === savedSelect.value);
  if (item) showInbox(item);
});
byId('about-button').addEventListener('click', () => about.showModal());
about.addEventListener('click', event => {
  if (event.target === about) about.close();
});
configureRepository();
showInbox();

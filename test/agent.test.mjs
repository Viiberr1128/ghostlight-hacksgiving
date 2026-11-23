import test from 'node:test';
import assert from 'node:assert/strict';
import { investigate, sampleInput } from '../lib/agent.mjs';
import { sampleGitHub } from '../lib/sample.mjs';

const target = { ...sampleInput, source: 'sample' };

test('the same promise gains evidence after a linked merge appears', async () => {
  const before = await investigate(target, sampleGitHub('before'));
  const after = await investigate(target, sampleGitHub('after'));
  assert.deepEqual(before.promises.map(item => item.status), ['open', 'review', 'open']);
  assert.deepEqual(after.promises.map(item => item.status), ['evidence', 'review', 'open']);
  const [done, draft, open] = after.promises;
  assert.equal(done.id, before.promises[0].id);
  assert.match(done.evidence[1].label, /#31 · Merged/);
  assert.match(done.draft, /confirm it reached the release/);
  assert.match(draft.evidence[1].label, /#23 · Draft/);
  assert.match(open.quote, /1\.0 release/);
  assert.equal(open.evidence.length, 1);
});

test('follows an explicit lead outside the recent PR page', async () => {
  const comment = {
    issue_url: 'https://api.github.com/repos/harbor-workshop/tide-clock/issues/9',
    body: 'I’ll add support for moon phases in #81.',
    user: { login: target.username },
    created_at: '2026-08-01T10:00:00Z',
    html_url: 'https://github.com/harbor-workshop/tide-clock/issues/9#issuecomment-8',
  };
  const calls = [];
  const fake = {
    snapshot: async () => ({ issues: [], comments: [comment], pulls: [] }),
    issue: async (repo, number) => {
      calls.push(['issue', repo, number]);
      return { number, title: 'Track moon phases', body: 'Follow the moon calendar.', state: 'open' };
    },
    pull: async (repo, number) => {
      calls.push(['pull', repo, number]);
      return { number, title: 'Support moon phases', body: 'Moon phases for every date.', merged_at: '2026-08-02T10:00:00Z' };
    },
  };
  const result = await investigate(target, fake);
  assert.deepEqual(calls, [['issue', target.repo, 9], ['pull', target.repo, 81]]);
  assert.equal(result.scanned.followed, 2);
  assert.equal(result.promises[0].status, 'evidence');
  assert.equal(result.promises[0].url, comment.html_url);
});

test('quoted text, author mismatch, and fenced examples do not become commitments', async () => {
  const issues = [
    { number: 1, user: { login: target.username }, body: ['> I’ll add cable guides.', '```js', 'const example = 42;', 'I’ll add a proof-of-concept.', '```', 'I will never add cable guides.', 'I’ll add station shortcuts.'].join('\n') },
    { number: 2, user: { login: 'someone-else' }, body: 'I’ll fix the broken battery.' },
  ];
  const result = await investigate(target, { snapshot: async () => ({ issues, comments: [], pulls: [] }) });
  assert.deepEqual(result.promises.map(item => item.quote), ['I’ll add station shortcuts.']);
});

test('a later linked revert makes a previously corroborated change uncertain', async () => {
  const base = sampleGitHub('after');
  const { issues, comments, pulls } = await base.snapshot();
  const reversal = { number: 39, title: 'Revert low-power mode', body: 'References #12.', merged_at: '2026-10-20T00:00:00Z', state: 'closed' };
  const result = await investigate(target, { ...base, snapshot: async () => ({ issues, comments, pulls: [...pulls, reversal] }) });
  assert.equal(result.promises[0].status, 'review');
  assert.match(result.promises[0].draft, /possible reversal in #39/);
  assert.equal(result.promises[0].evidence.some(item => item.confirmed), false);
});

test('a related merged PR without a reference remains review evidence', async () => {
  const base = sampleGitHub('after');
  const snapshot = await base.snapshot();
  const pulls = snapshot.pulls.map(item => item.number === 31 ? { ...item, body: 'Generic low-power mode design.' } : item);
  const result = await investigate(target, { ...base, snapshot: async () => ({ ...snapshot, pulls }) });
  assert.equal(result.promises[0].status, 'review');
  assert.match(result.promises[0].evidence[1].reason, /Similar wording/);
});

test('requires a personal, concrete commitment rather than an offer, suggestion, or hypothetical', async () => {
  const issue = {
    number: 12, user: { login: target.username },
    body: [
      'I can reproduce the crash on Windows.',
      'We should consider adding a theme switch.',
      'Let’s improve documentation.',
      'If that seems useful, I’ll add the feature.',
      'I’ll try to fix the import bug.',
      'Maybe I’ll review the updates.',
      'I’ll update the README before Friday.',
      'I plan to remove the compatibility shim.',
      'I’ll investigate and open a draft PR soon.',
    ].join('\n'),
  };
  const result = await investigate(target, { snapshot: async () => ({ issues: [issue], comments: [], pulls: [] }) });
  assert.deepEqual(result.promises.map(item => item.quote), [
    'I’ll update the README before Friday.',
    'I plan to remove the compatibility shim.',
    'I’ll investigate and open a draft PR soon.',
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboxStore } from '../lib/inbox.mjs';
import { makeServer } from '../server.mjs';

const recorded = JSON.parse(await readFile(new URL('../lib/replay.json', import.meta.url)));

async function openServer(options) {
  const server = makeServer(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {
    get: path => fetch(origin + path),
    post: data => fetch(origin + '/api/investigate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),
    close: () => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

test('historical replay shows a real merge and leaves the saved inbox empty', async t => {
  const api = await openServer();
  t.after(api.close);
  const before = await (await api.get('/api/replay')).json();
  const after = await (await api.get('/api/replay?stage=after')).json();
  const [first] = before.promises;
  const [second] = after.promises;

  assert.equal(before.source, 'history');
  assert.equal(first.status, 'review');
  assert.equal(first.id, second.id);
  assert.equal(second.status, 'evidence');
  assert.equal(second.previousStatus, 'review');
  assert.equal(after.changed, 1);
  assert.equal(second.url, recorded.comment.html_url);
  assert.equal(second.evidence.find(item => item.confirmed).url, recorded.pull.html_url);
  assert.deepEqual(await (await api.get('/api/inbox')).json(), { inboxes: [], report: null });

  assert.equal((await api.post({ repo: 'https://example.com/foo', username: 'alice' })).status, 400);
  assert.equal((await api.post({ repo: 'owner/..', username: 'alice' })).status, 400);
  assert.equal((await api.post({ repo: 'owner/repo', username: 'alice' })).status, 503);
  assert.equal((await api.post({ username: 'a'.repeat(3000) })).status, 400);
  assert.equal((await api.get('/.git/config')).status, 404);
});

test('recheck follows a saved promise past the recent window and persists a fresh merge across restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ghostlight-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'inbox.json');
  const { repo, username, issue, comment, pull } = recorded;
  const target = { repo, username };
  const initial = await openServer({
    inbox: createInboxStore({ file, clock: () => recorded.before }),
    allowedRepo: repo,
    github: {
      snapshot: async () => ({
        issues: [{ ...issue, state: 'open', closed_at: null }], comments: [comment],
        pulls: [{ ...pull, state: 'open', merged_at: null, updated_at: pull.created_at }],
      }),
    },
  });

  let first;
  try {
    const response = await initial.post(target);
    assert.equal(response.status, 200);
    [first] = (await response.json()).report.promises;
    assert.equal(first.status, 'review');
  } finally {
    await initial.close();
  }

  const calls = [];
  const recheck = await openServer({
    inbox: createInboxStore({ file, clock: () => recorded.after }),
    allowedRepo: repo,
    github: {
      snapshot: async () => ({ issues: [], comments: [], pulls: [] }),
      issue: async (name, number) => { calls.push(['issue', name, number]); return issue; },
      timeline: async (name, number) => {
        calls.push(['timeline', name, number]);
        return [{ event: 'cross-referenced', source: { issue: { ...pull, pull_request: {} } } }];
      },
      pull: async (name, number) => { calls.push(['pull', name, number]); return pull; },
    },
  });
  t.after(recheck.close);

  assert.equal((await (await recheck.get('/api/inbox')).json()).report.promises[0].status, 'review');
  const response = await recheck.post(target);
  assert.equal(response.status, 200);
  const { report } = await response.json();
  assert.equal(report.changed, 1);
  assert.equal(report.promises[0].status, 'evidence');
  assert.equal(report.promises[0].id, first.id);
  assert.equal(report.promises[0].firstSeenAt, first.firstSeenAt);
  assert.deepEqual(calls, [['issue', repo, issue.number], ['timeline', repo, issue.number], ['pull', repo, pull.number]]);
  assert.equal((await (await recheck.get('/api/inbox')).json()).report.promises[0].status, 'evidence');
});

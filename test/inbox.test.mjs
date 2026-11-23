import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareInbox, createInboxStore } from '../lib/inbox.mjs';

const firstScan = '2026-11-23T12:00:00.000Z';
const nextScan = '2026-11-23T12:05:00.000Z';
const laterScan = '2026-11-23T12:10:00.000Z';

const opening = (id, evidence = []) => ({ id, task: id, status: 'open', evidence });
const merged = (id, pullNumber = 7, mergedAt = nextScan) => ({
  id, task: id, status: 'evidence', evidence: [{ pullNumber, mergedAt, confirmed: true }],
});
const scan = (promises, repo = 'ghostlight/example', username = 'ExampleUser') => ({
  repo, username, source: 'github-connector', promises, scanned: { issues: 2, comments: 0, pulls: 1, followed: 0 },
});

async function testFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ghostlight-inbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'data', 'inboxes.json');
}

test('compares the same promise, puts changes first, and preserves promises missing from the scan', () => {
  const old = compareInbox(null, scan([opening('stays'), opening('changes'), opening('missing')]), firstScan);
  const current = compareInbox(old, scan([opening('stays'), merged('changes'), opening('new')]), nextScan);
  assert.equal(current.changed, 1);
  assert.equal(current.added, 1);
  assert.deepEqual(current.promises.map(item => item.id), ['changes', 'stays', 'missing', 'new']);
  assert.deepEqual(current.promises[0], {
    ...merged('changes'),
    firstSeenAt: firstScan,
    lastCheckedAt: nextScan,
    statusChangedAt: nextScan,
    previousStatus: 'open',
    observed: true,
    change: 'status',
  });
  assert.equal(current.promises[1].statusChangedAt, firstScan);
  assert.equal(current.promises[1].lastCheckedAt, nextScan);
  assert.equal(current.promises[1].change, null);
  assert.equal(current.promises[2].observed, false);
  assert.equal(current.promises[2].lastCheckedAt, firstScan);
  assert.equal(current.promises[2].previousStatus, 'open');
  assert.equal(old.promises[1].status, 'open');
});

test('a limited new scan preserves verified merge evidence, while a later reversal can change the status', () => {
  const oldPromise = merged('changes', 7, firstScan);
  const old = compareInbox(null, scan([oldPromise]), firstScan);
  const noMatch = compareInbox(old, scan([opening('changes')]), nextScan);
  assert.equal(noMatch.changed, 0);
  assert.equal(noMatch.promises[0].status, 'evidence');
  assert.deepEqual(noMatch.promises[0].evidence, oldPromise.evidence);
  assert.equal(noMatch.promises[0].observed, false);
  assert.equal(noMatch.promises[0].lastCheckedAt, firstScan);

  const reversal = {
    id: 'changes', task: 'changes', status: 'review',
    evidence: [
      { pullNumber: 7, mergedAt: firstScan, confirmed: false },
      { pullNumber: 8, mergedAt: laterScan, reversal: true },
    ],
  };
  const reversed = compareInbox(noMatch, scan([reversal]), laterScan);
  assert.equal(reversed.changed, 1);
  assert.equal(reversed.promises[0].status, 'review');
  assert.equal(reversed.promises[0].statusChangedAt, laterScan);
  assert.equal(reversed.promises[0].previousStatus, 'evidence');
  assert.equal(reversed.promises[0].observed, true);
});

test('records changed evidence without counting a status transition or an evidence reorder', () => {
  const issue = { label: 'Issue #1', text: 'The promise', date: firstScan };
  const pr = { label: 'Pull request #3', text: 'Related work', date: firstScan, pullNumber: 3 };
  const previous = compareInbox(null, scan([opening('promise', [issue, pr])]), firstScan);
  const reordered = compareInbox(previous, scan([opening('promise', [pr, issue])]), nextScan);
  assert.equal(reordered.promises[0].change, null);

  const updated = compareInbox(reordered, scan([opening('promise', [issue, { ...pr, text: 'More related work' }])]), laterScan);
  assert.equal(updated.changed, 0);
  assert.equal(updated.promises[0].change, 'evidence');
  assert.equal(updated.promises[0].statusChangedAt, firstScan);
});

test('persists a report across store instances and handles target casing', async t => {
  const file = await testFile(t);
  const store = createInboxStore({ file, clock: () => new Date(firstScan) });
  const created = await store.record(scan([opening('promise')]));
  assert.equal(created.scannedAt, firstScan);
  assert.equal(created.added, 1);

  const reopened = createInboxStore({ file, clock: () => new Date(nextScan) });
  const saved = await reopened.get('Ghostlight/Example', 'exampleuser');
  assert.deepEqual(saved, created);

  const updated = await reopened.record(scan([merged('promise')], 'Ghostlight/Example', 'exampleuser'));
  assert.equal(updated.changed, 1);
  assert.equal(updated.promises[0].firstSeenAt, firstScan);
  assert.deepEqual(await reopened.list(), [{
    repo: 'Ghostlight/Example', username: 'exampleuser', scannedAt: nextScan, count: 1,
  }]);
  assert.equal(await reopened.get('ghostlight/example', 'different-user'), null);

  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.inboxes.length, 1);
  assert.equal(disk.inboxes[0].promises[0].status, 'evidence');
});

test('serializes concurrent writes and reads without dropping a target or exposing mutable state', async t => {
  const file = await testFile(t);
  const times = [firstScan, nextScan, laterScan];
  const store = createInboxStore({ file, clock: () => new Date(times.shift()) });
  const first = store.record(scan([opening('first')]));
  const same = store.record(scan([merged('first'), opening('second')]));
  const other = store.record(scan([opening('third')], 'ghostlight/other'));
  const queuedRead = store.get('ghostlight/example', 'ExampleUser');
  const [, refreshed, , readback] = await Promise.all([first, same, other, queuedRead]);

  assert.equal(refreshed.changed, 1);
  assert.deepEqual(readback, refreshed);
  readback.promises[0].status = 'tampered';
  assert.equal((await store.get('ghostlight/example', 'ExampleUser')).promises[0].status, 'evidence');

  const reopened = createInboxStore({ file });
  assert.deepEqual((await reopened.list()).map(report => report.repo), ['ghostlight/other', 'ghostlight/example']);
});

test('keeps unreadable saved data from being silently overwritten', async t => {
  const file = await testFile(t);
  const store = createInboxStore({ file });
  await store.record(scan([opening('first')]));
  await writeFile(file, 'incomplete json');
  const reopened = createInboxStore({ file });
  await assert.rejects(reopened.record(scan([merged('first')])), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), 'incomplete json');
});

test('archive bounds preserve current unresolved work before old matched merges', () => {
  const previous = compareInbox(null, scan(Array.from({ length: 120 }, (_, index) => merged('old ' + index))), firstScan);
  const result = compareInbox(previous, scan([opening('current')]), nextScan);
  assert.equal(result.promises.length, 120);
  assert.equal(result.promises[0].id, 'current');
  assert.equal(result.added, 1);
});

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const maxInboxes = 32;
const maxPromises = 120;

function targetKey(repo, username) {
  return repo.toLowerCase() + '@' + username.toLowerCase();
}

function mostRecentFirst(a, b) {
  return a.scannedAt < b.scannedAt ? 1 : a.scannedAt > b.scannedAt ? -1 : 0;
}

function evidenceFingerprint(promise) {
  const evidence = (promise.evidence ?? []).map(item => JSON.stringify([
    item.label, item.text, item.excerpt, item.reason, item.date, item.url,
    item.pullNumber, item.mergedAt, item.confirmed, item.reversal,
  ]));
  return JSON.stringify(evidence.sort());
}

function isMerge(item) {
  return Number.isSafeInteger(item.pullNumber) && item.pullNumber > 0
    && Number.isFinite(Date.parse(item.mergedAt));
}

function lostMergeEvidence(previous, current) {
  if (previous.status !== 'evidence' || current.status === 'evidence') return false;

  const oldMerges = (previous.evidence ?? []).filter(item => item.confirmed && isMerge(item));
  const oldNumbers = new Set(oldMerges.map(item => item.pullNumber));
  const oldMergeTime = Math.max(...oldMerges.map(item => Date.parse(item.mergedAt)));
  const currentEvidence = current.evidence ?? [];
  const confirmsOldMerge = currentEvidence.some(item => item.confirmed && isMerge(item) && oldNumbers.has(item.pullNumber));
  const showsLaterReversal = currentEvidence.some(item => item.reversal === true && isMerge(item)
    && !oldNumbers.has(item.pullNumber) && Date.parse(item.mergedAt) >= oldMergeTime);

  return !confirmsOldMerge && !showsLaterReversal;
}

function retainUnobserved(previous) {
  return { ...previous, previousStatus: previous.status, observed: false, change: null };
}

function observedPromise(previous, current, scannedAt) {
  const statusChanged = previous && previous.status !== current.status;
  const evidenceChanged = previous && evidenceFingerprint(previous) !== evidenceFingerprint(current);
  let change = null;
  if (!previous) change = 'added';
  else if (statusChanged) change = 'status';
  else if (evidenceChanged) change = 'evidence';

  return {
    ...current,
    firstSeenAt: previous?.firstSeenAt ?? scannedAt,
    lastCheckedAt: scannedAt,
    statusChangedAt: statusChanged ? scannedAt : previous?.statusChangedAt ?? scannedAt,
    previousStatus: previous?.status ?? null,
    observed: true,
    change,
  };
}

function needsAttention(promise) {
  return promise.status !== 'evidence';
}

function changedSinceLastScan(promise) {
  return promise.change === 'status' || promise.change === 'evidence';
}

function sortForReading(a, b) {
  return Number(changedSinceLastScan(b)) - Number(changedSinceLastScan(a))
    || Number(needsAttention(b)) - Number(needsAttention(a));
}

function retainWithinLimit(promises) {
  if (promises.length <= maxPromises) return promises;
  const allowed = [...promises].sort((a, b) =>
    Number(needsAttention(b) && b.observed) - Number(needsAttention(a) && a.observed)
    || Number(needsAttention(b)) - Number(needsAttention(a))
    || Number(b.observed) - Number(a.observed)
    || Number(changedSinceLastScan(b)) - Number(changedSinceLastScan(a))
    || b.firstSeenAt.localeCompare(a.firstSeenAt))
    .slice(0, maxPromises);
  const keptIds = new Set(allowed.map(promise => promise.id));
  return promises.filter(promise => keptIds.has(promise.id));
}

export function compareInbox(previous, result, scannedAt) {
  const timestamp = new Date(scannedAt).toISOString();
  const saved = new Map((previous?.promises ?? []).map(promise => [promise.id, retainUnobserved(promise)]));
  const priorById = new Map((previous?.promises ?? []).map(promise => [promise.id, promise]));

  for (const promise of result.promises) {
    const prior = priorById.get(promise.id);
    if (prior && lostMergeEvidence(prior, promise)) continue;
    saved.set(promise.id, observedPromise(prior, promise, timestamp));
  }

  const promises = retainWithinLimit([...saved.values()]).sort(sortForReading);
  return {
    ...result,
    scannedAt: timestamp,
    promises,
    changed: promises.filter(promise => promise.change === 'status').length,
    added: promises.filter(promise => promise.change === 'added').length,
  };
}

async function persist(file, inboxes) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify({ version: 1, inboxes }), { flag: 'wx', mode: 0o600 })
    .then(() => rename(temporary, file))
    .catch(async error => {
      await unlink(temporary).catch(() => {});
      throw error;
    });
}

export function createInboxStore({ file, clock = () => new Date() } = {}) {
  let inboxes;
  let pending = Promise.resolve();

  function serialize(action) {
    const operation = pending.then(action);
    pending = operation.catch(() => {});
    return operation;
  }

  async function load() {
    if (inboxes) return inboxes;
    if (!file) return (inboxes = []);

    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.inboxes)) throw new Error('Unrecognized inbox data format.');
      inboxes = data.inboxes;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      inboxes = [];
    }
    return inboxes;
  }

  return {
    list: () => serialize(async () => (await load()).map(report => ({
      repo: report.repo,
      username: report.username,
      scannedAt: report.scannedAt,
      count: report.promises.length,
    }))),
    get: (repo, username) => serialize(async () => {
      const key = targetKey(repo, username);
      const report = (await load()).find(item => targetKey(item.repo, item.username) === key);
      return report ? structuredClone(report) : null;
    }),
    record: result => {
      const scan = structuredClone(result);
      return serialize(async () => {
        const current = await load();
        const key = targetKey(scan.repo, scan.username);
        const sameTarget = item => targetKey(item.repo, item.username) === key;
        const report = compareInbox(current.find(sameTarget), scan, clock());
        const next = [report, ...current.filter(item => !sameTarget(item))]
          .sort(mostRecentFirst)
          .slice(0, maxInboxes);
        if (file) await persist(file, next);
        inboxes = next;
        return structuredClone(report);
      });
    },
  };
}

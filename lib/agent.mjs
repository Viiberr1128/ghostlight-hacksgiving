const promiseCue = /\bI(?:['’]ll|\s+(?:will|plan to|am going to)|['’]m going to)\s+([a-z](?:[^\n.!?]|\.(?=[^\s.]))*)(?:[.!?](?=\s|$)|$)/gi;
const actions = /^(?:add|address|answer|backport|build|change|check|clean up|close|commit|confirm|create|deploy|document|draft|edit|file|fix|follow up|implement|investigate|look into|merge|move|open|patch|post|prepare|publish|push|raise|rebase|redo|release|remove|rename|replace|reply|reproduce|resolve|review|rewrite|run|send|ship|split|submit|take a look at|test|tidy up|update|verify|write)\b/i;
const conditional = /\b(?:if|unless|provided that|depending on|maybe|perhaps|probably)\b/i;
const quotedOrReported = /[“”"‘]|\b(?:said|wrote|quoted)\b/i;
const promisesPullRequest = /\b(?:open|create|submit|post|raise|send)\s+(?:(?:a|the|my)\s+)?(?:draft\s+)?(?:pr|pull request)\b/i;
const noise = new Set('about across after again also and before behind being both can could does done follow followup from have into just like mode need next only other over same should since some than that their them then there these they this through under until update updated upon very want were what when where which while will with work would your issue pull request'.split(' '));

export const sampleInput = { repo: 'harbor-workshop/tide-clock', username: 'mara-chen' };
const compare = (a, b) => a === b ? 0 : (a < b ? -1 : 1);
const dateOf = item => item.created_at || '';
const numberOf = item => Number((item.issue_url || '').match(/\/issues\/(\d+)$/)?.[1] || item.number);
const validNumber = number => Number.isSafeInteger(number) && number > 0;

function readable(text = '', preserveLinks = false) {
  return String(text ?? '')
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/^\s*>[^\n]*/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, preserveLinks ? '$1 $2' : '$1');
}

function compact(text = '', limit = 260) {
  const plain = readable(text).replace(/\s+/g, ' ').trim();
  return plain.length > limit ? plain.slice(0, limit - 1).trimEnd() + '…' : plain;
}

function words(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(word => !noise.has(word))
    .map(word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word));
}

function overlap(a, b) {
  return [...a].filter(word => b.has(word)).length;
}

function references(text, repo) {
  const ids = new Set();
  const scrubbed = readable(text, true).replace(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/gi,
    (_, target, number) => target.toLowerCase() === repo.toLowerCase() ? ' #' + number : ' ');
  for (const match of scrubbed.matchAll(/(?:^|[\s(])#(\d+)\b/g)) {
    const number = Number(match[1]);
    if (validNumber(number)) ids.add(number);
  }
  return ids;
}

function sourceLink(item, repo) {
  try {
    const url = new URL(item.html_url);
    const prefix = '/' + repo.toLowerCase() + '/';
    if (url.origin === 'https://github.com' && !url.username && !url.password
      && url.pathname.toLowerCase().startsWith(prefix)
      && /^(?:pull|issues)\/\d+$/.test(url.pathname.slice(prefix.length))) return url.href;
  } catch {
    // Sample threads have no public URL.
  }
  return null;
}

function promisesIn(item) {
  const text = readable(item.body).replace(/\r/g, '');
  return [...text.matchAll(promiseCue)].flatMap(match => {
    const task = match[1].trim().replace(/[.,;:]+$/, '')
      .replace(/\s+(?:in a follow-up|this week|before the \S+ release)$/, '');
    const prefix = text.slice(0, match.index).split(/[\n.!?]/).at(-1);
    if (task.length < 8 || task.length > 220 || !actions.test(task) || conditional.test(task)
      || conditional.test(prefix) || quotedOrReported.test(prefix) || !words(task).size) return [];
    return [{ task: task[0].toUpperCase() + task.slice(1), quote: compact(match[0]) }];
  });
}

async function lookup(numbers, get) {
  const results = await Promise.all(numbers.map(async number => {
    try {
      return await get(number);
    } catch (error) {
      if (error.status !== 404) throw error;
      return null;
    }
  }));
  return results.filter(Boolean);
}

function parentLabel(parent, number) {
  return (parent?.pull_request || parent?.head ? 'Pull request #' : 'Issue #') + number;
}

function makeCandidate(pull, promise, repo, parents, crossReferences, username) {
  if (pull.number === promise.number || !validNumber(pull.number)) return null;
  const combined = String(pull.title ?? '') + '\n' + String(pull.body ?? '');
  const related = references(combined, repo);
  const indicatesReversal = /\b(?:revert(?:s|ed|ing)?|rollback|back\s*out|remove(?:s|d)?)\b/i.test(pull.title ?? '');
  const linked = related.has(promise.number)
    || crossReferences.get(promise.number)?.has(pull.number)
    || references(promise.quote, repo).has(pull.number)
    || references(parents.get(promise.number)?.body, repo).has(pull.number)
    || (indicatesReversal && promise.priorPulls?.some(number => related.has(number)));
  const titleOverlap = overlap(words(promise.task), words(pull.title ?? ''));
  const bodyOverlap = overlap(words(promise.task), words(combined));
  const contextual = overlap(words(parents.get(promise.number)?.title ?? ''), words(pull.title ?? ''));
  const time = pull.merged_at || pull.updated_at || dateOf(pull);
  if (promise.date && time && time < promise.date) return null;
  if (!linked && titleOverlap < 2) return null;
  const authoredProof = pull.user?.login?.toLowerCase() === username.toLowerCase() && promisesPullRequest.test(promise.task);
  const topicProof = bodyOverlap >= Math.min(2, words(promise.task).size) && (titleOverlap >= 1 || contextual >= 2);
  const corroborated = Boolean(pull.merged_at && linked && !indicatesReversal && (topicProof || authoredProof));
  return {
    number: pull.number, title: compact(pull.title, 150), body: compact(pull.body),
    state: pull.merged_at ? 'Merged' : (pull.state === 'closed' ? 'Closed without merge' : (pull.draft ? 'Draft' : 'Open')),
    date: time, mergedAt: pull.merged_at || null, url: sourceLink(pull, repo), linked, indicatesReversal, corroborated, authoredProof,
    score: (corroborated ? 12 : 0) + (linked ? 6 : 0) + 2 * titleOverlap + Math.min(4, bodyOverlap),
  };
}

function present(promise, parent, candidates, repo) {
  const label = parent ? parentLabel(parent, promise.number) : (promise.parentLabel ?? parentLabel(null, promise.number));
  const merged = candidates.find(candidate => candidate.corroborated);
  const reversal = merged && candidates.find(candidate => candidate.indicatesReversal && candidate.linked
    && candidate.state === 'Merged' && candidate.date >= merged.date);
  const status = merged && !reversal ? 'evidence' : candidates.length || parent?.state === 'closed' ? 'review' : 'open';
  const previous = candidates[0];
  let draft = 'I still owe a follow-up here. I’ll check what’s left and report back in this thread.';
  if (status === 'evidence') {
    draft = 'I found a merged change that appears to cover this in #' + merged.number
      + '. I’ll confirm it reached the release and close the loop here.';
  } else if (reversal) {
    draft = 'I found a change in #' + merged.number + ' and a possible reversal in #' + reversal.number
      + '. I’ll check the current behavior before calling this done.';
  } else if (previous) {
    draft = 'I found related work in #' + previous.number + '. I’ll check whether it covers this and post an update here.';
  } else if (parent?.state === 'closed') {
    draft = 'This thread is already closed. I’ll check whether the follow-up landed and leave a note here.';
  }

  const evidence = [{
    label: label + ' · The promise',
    text: compact(parent?.title || promise.quote), date: promise.date, url: promise.url,
  }];
  for (const candidate of candidates.slice(0, 3)) {
    let reason = candidate.linked ? 'References the original thread.' : 'Similar wording. Review the relationship.';
    if (candidate.linked && candidate.authoredProof) reason = 'Opened by the person who made the commitment, with a link to the original thread.';
    if (candidate.indicatesReversal) reason = 'The title suggests the change may undo earlier work.';
    evidence.push({
      label: 'Pull request #' + candidate.number + ' · ' + candidate.state,
      text: candidate.title, excerpt: candidate.body, reason, date: candidate.date, url: candidate.url,
      pullNumber: candidate.number, mergedAt: candidate.mergedAt, reversal: candidate.indicatesReversal,
      confirmed: candidate.corroborated && !reversal,
    });
  }
  if (!candidates.length && parent?.state === 'closed') evidence.push({
    label: label + ' · Closed', text: 'The thread closed without a matching change in the records reviewed.',
    date: parent.closed_at ?? '', url: sourceLink(parent, repo),
  });

  const { id, number, task, quote, date, url } = promise;
  return { id, number, task, quote, date, url, parentLabel: label, status, evidence, draft };
}

/** Scan a bounded GitHub snapshot, then follow specific issue and PR leads. */
export async function investigate({ repo, username, source }, github, saved = []) {
  const { issues, comments, pulls } = await github.snapshot(repo);
  const parents = new Map([...issues, ...pulls].map(item => [item.number, item]));
  const documents = [...issues, ...pulls, ...comments]
    .filter(item => item.user?.login?.toLowerCase() === username.toLowerCase())
    .sort((a, b) => compare(dateOf(b), dateOf(a)));
  const seen = new Set();
  const promises = [];
  for (const item of documents) {
    const number = numberOf(item);
    if (!validNumber(number)) continue;
    for (const promise of promisesIn(item)) {
      const key = number + '-' + promise.task.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      promises.push({ ...promise, id: key, number, date: dateOf(item), url: sourceLink(item, repo) });
    }
    if (promises.length >= 10) break;
  }
  const discoveries = promises.slice(0, 10);
  const indexed = new Set(discoveries.map(promise => promise.id));
  const tracked = saved
    .filter(promise => !indexed.has(promise.id) && validNumber(promise.number))
    .sort((a, b) => compare(a.lastCheckedAt || '', b.lastCheckedAt || ''))
    .slice(0, 4).map(promise => ({ ...promise }));
  const selected = [...tracked, ...discoveries];
  const previousById = new Map(saved.map(promise => [promise.id, promise]));
  for (const promise of selected) {
    const earlier = previousById.get(promise.id);
    const priorPulls = (earlier?.evidence || []).filter(item => item.confirmed || item.reversal)
      .map(item => item.pullNumber).filter(validNumber);
    if (priorPulls.length) promise.priorPulls = priorPulls;
  }
  const threads = [...new Set(selected.map(promise => promise.number))];
  const missingParents = threads.filter(number => !parents.has(number)).slice(0, 5);
  for (const issue of await lookup(missingParents, number => github.issue(repo, number))) parents.set(issue.number, issue);

  const crossReferences = new Map();
  const checkedThreads = typeof github.timeline === 'function' ? threads.slice(0, 4) : [];
  await Promise.all(checkedThreads.map(async number => {
    const [events] = await lookup([number], id => github.timeline(repo, id));
    const linked = (events || []).filter(event => event.event === 'cross-referenced')
      .map(event => event.source?.issue)
      .filter(issue => issue?.pull_request && validNumber(issue.number) && sourceLink(issue, repo));
    crossReferences.set(number, new Set(linked.map(issue => issue.number)));
  }));

  const knownPulls = new Map(pulls.map(pull => [pull.number, pull]));
  const leads = new Set();
  for (const promise of selected) {
    for (const id of promise.priorPulls || []) leads.add(id);
    for (const id of crossReferences.get(promise.number) || []) if (id !== promise.number) leads.add(id);
    for (const id of references(promise.quote, repo)) if (id !== promise.number) leads.add(id);
    for (const id of references(parents.get(promise.number)?.body, repo)) if (id !== promise.number) leads.add(id);
  }
  for (const promise of selected) {
    for (const pull of pulls) {
      const candidate = makeCandidate(pull, promise, repo, parents, crossReferences, username);
      if (candidate && pull.state === 'closed' && !Object.hasOwn(pull, 'merged_at')) leads.add(pull.number);
    }
  }
  const followed = [...leads].filter(id => !knownPulls.has(id) || !Object.hasOwn(knownPulls.get(id), 'merged_at')).slice(0, 7);
  for (const pull of await lookup(followed, number => github.pull(repo, number))) knownPulls.set(pull.number, pull);

  const results = selected.flatMap(promise => {
    const candidates = [...knownPulls.values()].map(pull => makeCandidate(pull, promise, repo, parents, crossReferences, username))
      .filter(Boolean).sort((a, b) => (b.score - a.score) || compare(b.date, a.date));
    const parent = parents.get(promise.number);
    if (!indexed.has(promise.id) && !parent && !candidates.length) return [];
    return [present(promise, parent, candidates, repo)];
  });

  return {
    repo, username, source, promises: results,
    scanned: { issues: issues.length, comments: comments.length, pulls: pulls.length, followed: missingParents.length + checkedThreads.length + followed.length },
  };
}

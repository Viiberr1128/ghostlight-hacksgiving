import { readFile } from 'node:fs/promises';
import { investigate } from './agent.mjs';
import { compareInbox } from './inbox.mjs';

const recorded = JSON.parse(await readFile(new URL('./replay.json', import.meta.url), 'utf8'));

function githubAt(cutoff) {
  const { issue, comment, pull } = recorded;
  const closed = Date.parse(issue.closed_at) <= cutoff;
  const merged = Date.parse(pull.merged_at) <= cutoff;
  return {
    snapshot: async () => ({
      issues: [{ ...issue, state: closed ? 'closed' : 'open', closed_at: closed ? issue.closed_at : null }],
      comments: [comment],
      pulls: [{
        ...pull,
        state: merged ? 'closed' : 'open',
        merged_at: merged ? pull.merged_at : null,
        closed_at: merged ? pull.closed_at : null,
        updated_at: merged ? pull.merged_at : pull.created_at,
      }],
    }),
    pull: async () => { throw Object.assign(new Error('PR is outside the replay.'), { status: 404 }); },
  };
}

/** Reconstruct two GitHub states from verified creation, close, and merge times. */
export async function replayMerge(stage) {
  const { repo, username, before, after } = recorded;
  const target = { repo, username, source: 'history' };
  const first = compareInbox(null, await investigate(target, githubAt(Date.parse(before))), before);
  if (stage === 'after') {
    const second = await investigate(target, githubAt(Date.parse(after)), first.promises);
    return { ...compareInbox(first, second, after), stage, mergedAt: recorded.pull.merged_at };
  }
  return { ...first, stage: 'before', mergedAt: recorded.pull.merged_at };
}

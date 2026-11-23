import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../lib/github.mjs';

const repo = 'harbor-workshop/tide-clock';
const gateway = 'https://api.sprites.dev/v1/gateway/github/conn_example';
const root = gateway + '/repos/' + repo;
const issueQuery = '?state=all&sort=updated&direction=desc&per_page=30';
const commentQuery = '?sort=updated&direction=desc&per_page=50';

test('scans the latest bounded GitHub records through the configured Connector', async () => {
  const issue = { number: 12, body: 'Issue body', state: 'open' };
  const pull = { number: 13, body: 'Pull body' };
  const comments = [
    { id: 2, issue_url: 'https://api.github.com/repos/' + repo + '/issues/12', body: 'Issue comment' },
    { id: 3, issue_url: 'https://api.github.com/repos/' + repo + '/issues/13', body: 'Pull request comment' },
  ];
  const records = new Map([
    [root + '/issues' + issueQuery, [issue, { ...pull, pull_request: {} }]],
    [root + '/issues/comments' + commentQuery, comments],
    [root + '/pulls' + issueQuery, [pull]],
  ]);
  const requests = [];
  const github = createGitHub({
    gateway: gateway + '/',
    fetchImpl: (url, options) => {
      assert.ok(records.has(url), 'Every request stays within the configured Connector');
      requests.push({ url, options });
      return Response.json(records.get(url));
    },
  });

  const pending = github.snapshot(repo);
  assert.deepEqual(requests.map(request => request.url), [...records.keys()]);
  assert.deepEqual(await pending, { issues: [issue], comments, pulls: [pull] });
  for (const { options } of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(new Headers(options.headers).has('cookie'), false);
  }
});

test('reads targeted issue and pull request numbers using fixed GET paths', async () => {
  const requests = [];
  const github = createGitHub({
    gateway,
    fetchImpl: (url, { method }) => {
      requests.push([url, method]);
      return Response.json({ number: Number(url.split('/').at(-1)), state: 'closed' });
    },
  });
  assert.deepEqual(await github.issue(repo, 12), { number: 12, state: 'closed' });
  assert.deepEqual(await github.pull(repo, 13), { number: 13, state: 'closed' });
  assert.deepEqual(requests, [[root + '/issues/12', 'GET'], [root + '/pulls/13', 'GET']]);
});

test('rejects invalid coordinates before an upstream request', async () => {
  let attempts = 0;
  const github = createGitHub({
    gateway,
    fetchImpl: () => {
      attempts += 1;
      throw new Error('Unexpected fetch');
    },
  });
  for (const malformed of ['https://example.com/r', 'owner/repo/path', 'owner/..', 'owner/.', 'owner/%2e%2e', 'owner/repo?token=hi']) {
    await assert.rejects(github.snapshot(malformed), { status: 400 });
  }
  for (const number of [0, -1, 2.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(github.pull(repo, number), { status: 400 });
    await assert.rejects(github.issue(repo, number), { status: 400 });
  }
  assert.equal(attempts, 0);
});

test('maps provider failures without propagating a body, redirect or fetch exception', async () => {
  const secret = 'provider-private-string';
  const fixtures = [
    [() => new Response(secret, { status: 403 }), 403],
    [() => new Response(secret, { status: 403, headers: { 'X-RateLimit-Remaining': '0' } }), 429],
    [() => new Response(secret, { status: 404 }), 404],
    [() => new Response(secret, { status: 429 }), 429],
    [() => new Response(secret, { status: 503 }), 503],
    [() => Response.redirect('https://example.com/' + secret), 502],
    [() => { throw new Error(secret); }, 502],
  ];
  for (const [reply, expectedStatus] of fixtures) {
    const requests = [];
    const github = createGitHub({
      gateway,
      fetchImpl: (url, options) => {
        requests.push([url, options.redirect]);
        return reply();
      },
    });
    await assert.rejects(github.pull(repo, 13), error => {
      assert.equal(error.status, expectedStatus);
      assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(requests, [[root + '/pulls/13', 'error']]);
  }
});

test('rejects malformed upstream JSON and unexpected data shapes', async () => {
  const create = reply => createGitHub({ gateway, fetchImpl: reply });
  await assert.rejects(create(() => new Response('garbled')).pull(repo, 13), { status: 502 });
  await assert.rejects(create(() => Response.json({ number: 12 })).pull(repo, 13), { status: 502 });
  await assert.rejects(create(() => Response.json(null)).issue(repo, 13), { status: 502 });
  await assert.rejects(create(() => Response.json({ items: [] })).snapshot(repo), { status: 502 });
  await assert.rejects(create(() => Response.json([null])).snapshot(repo), { status: 502 });
});

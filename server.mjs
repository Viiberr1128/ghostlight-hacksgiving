import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { investigate } from './lib/agent.mjs';
import { createInboxStore } from './lib/inbox.mjs';
import { replayMerge } from './lib/replay.mjs';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/portland-head-light.webp', ['portland-head-light.webp', 'image/webp']],
  ['/beacon.svg', ['beacon.svg', 'image/svg+xml']],
  ['/newsreader.woff2', ['newsreader.woff2', 'font/woff2']],
  ['/dm-sans.woff2', ['dm-sans.woff2', 'font/woff2']],
]);

const validRepo = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i;
const validUsername = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const spriteGateway = /^https:\/\/api\.sprites\.dev\/v1\/gateway\/(?:github|custom_api)\/[a-zA-Z0-9_-]+$/;

function respond(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

async function readJSON(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2048) {
      req.resume();
      return null;
    }
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return null;
  }
}

function normalizeTarget(repoValue, usernameValue) {
  const repo = typeof repoValue === 'string' ? repoValue.trim() : '';
  const username = typeof usernameValue === 'string' ? usernameValue.trim().replace(/^@/, '') : '';
  if (!validRepo.test(repo) || ['.', '..'].includes(repo.split('/')[1] ?? '') || !validUsername.test(username)) return null;
  return { repo, username };
}

export function makeServer({ github, source = 'github-connector', allowedRepo = '', inbox = createInboxStore() } = {}) {
  let active = false;
  const isAllowed = repo => !allowedRepo || allowedRepo.toLowerCase() === repo.toLowerCase();

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const file = staticFiles.get(path);
      if (req.method === 'GET' && file) {
        const [name, type] = file;
        return respond(res, 200, await readFile(new URL('./public/' + name, import.meta.url)), type);
      }
      if (req.method === 'GET' && path === '/api/health') {
        return respond(res, 200, { ok: true, live: github ? source : null, allowedRepo: allowedRepo || null });
      }
      if (req.method === 'GET' && path === '/api/replay') {
        return respond(res, 200, await replayMerge(url.searchParams.get('stage')));
      }
      if (req.method === 'GET' && path === '/api/inbox') {
        const inboxes = (await inbox.list()).filter(item => isAllowed(item.repo));
        const explicit = url.searchParams.has('repo') || url.searchParams.has('username');
        const target = explicit
          ? normalizeTarget(url.searchParams.get('repo'), url.searchParams.get('username'))
          : inboxes[0];
        if (explicit && !target) return respond(res, 400, { error: 'Choose a valid repository and username.' });
        if (target && !isAllowed(target.repo)) return respond(res, 403, { error: 'This deployment is configured for ' + allowedRepo + '.' });
        const report = target ? await inbox.get(target.repo, target.username) : null;
        return respond(res, 200, { inboxes, report });
      }
      if (req.method !== 'POST' || path !== '/api/investigate') {
        return respond(res, 404, { error: 'That page does not exist.' });
      }

      const input = await readJSON(req);
      const target = normalizeTarget(input?.repo, input?.username);
      if (!target) return respond(res, 400, { error: 'Enter a GitHub repository as owner/name and a GitHub username.' });
      const { repo, username } = target;
      if (!isAllowed(repo)) return respond(res, 403, { error: 'This deployment is configured for ' + allowedRepo + '.' });
      if (!github) return respond(res, 503, { error: 'Connect GitHub to investigate this repository.' });
      if (active) return respond(res, 429, { error: 'An investigation is in progress. Try again in a moment.' });

      active = true;
      try {
        const previous = await inbox.get(repo, username);
        const result = await investigate({ repo, username, source }, github, previous?.promises);
        const report = await inbox.record(result);
        const inboxes = (await inbox.list()).filter(item => isAllowed(item.repo));
        return respond(res, 200, { report, inboxes });
      } finally {
        active = false;
      }
    } catch (error) {
      const status = [400, 403, 404, 429, 502, 503, 504].includes(error.status) ? error.status : 500;
      const messages = {
        400: 'Enter a valid GitHub repository and username.',
        403: 'GitHub or the Connector refused this repository. Check the Connector policy and repository access.',
        404: 'GitHub could not find that repository. Check the owner and repository name.',
        429: 'GitHub’s request limit was reached. Try again when the limit resets.',
        502: 'Ghostlight could not read the GitHub records. Try again in a moment.',
        503: 'GitHub or the Connector is temporarily unavailable. Try again in a moment.',
        504: 'The GitHub request took too long. Try again in a moment.',
      };
      if (!res.headersSent) respond(res, status, { error: messages[status] ?? 'Ghostlight couldn’t complete the investigation.' });
    }
  });
}

async function main() {
  const gateway = process.env.GHOSTLIGHT_GATEWAY?.replace(/\/$/, '');
  const direct = process.env.GHOSTLIGHT_LOCAL_PUBLIC_GITHUB === '1';
  if (gateway && !spriteGateway.test(gateway)) throw new Error('Use the exact HTTPS Sprites GitHub Connector base URL.');
  if (gateway && direct) throw new Error('Choose a single GitHub transport.');
  const allowedRepo = process.env.GHOSTLIGHT_ALLOWED_REPO ?? '';
  if (allowedRepo && (!validRepo.test(allowedRepo) || ['.', '..'].includes(allowedRepo.split('/')[1]))) {
    throw new Error('Set GHOSTLIGHT_ALLOWED_REPO to an owner/name pair.');
  }
  let github;
  if (gateway || direct) {
    const { createGitHub } = await import('./lib/github.mjs');
    github = createGitHub({ gateway: gateway || 'https://api.github.com' });
  }
  const port = Number(process.env.PORT || 8080);
  const host = process.env.GHOSTLIGHT_HOST || '127.0.0.1';
  const stateRoot = process.env.GHOSTLIGHT_DATA_DIR ?? join(gateway ? homedir() : process.cwd(), '.ghostlight');
  const inbox = createInboxStore({ file: join(stateRoot, 'inbox.json') });
  const app = makeServer({ github, source: direct ? 'github-direct' : 'github-connector', allowedRepo, inbox });
  app.listen(port, host, () => console.log('Ghostlight listening on ' + host + ':' + port));
}

const entryScript = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entryScript === fileURLToPath(import.meta.url)) await main();

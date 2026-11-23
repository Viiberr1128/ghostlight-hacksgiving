const validRepository = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i;
const timeoutMs = 8_000;
const issueQuery = '?state=all&sort=updated&direction=desc&per_page=30';
const commentQuery = '?sort=updated&direction=desc&per_page=50';

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function repositoryPath(repo) {
  if (typeof repo !== 'string' || !validRepository.test(repo) || ['.', '..'].includes(repo.split('/')[1])) {
    throw new GitHubError(400, 'Enter a GitHub repository as owner/name.');
  }
  return '/repos/' + repo;
}

function validNumber(number) {
  return Number.isSafeInteger(number) && number > 0;
}

function itemPath(repo, collection, number) {
  if (!validNumber(number)) throw new GitHubError(400, 'Enter a positive issue or pull request number.');
  return repositoryPath(repo) + '/' + collection + '/' + number;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse() {
  return new GitHubError(502, 'GitHub returned an unexpected response.');
}

function responseError(response) {
  const { status, headers } = response;
  if (status === 429 || (status === 403 && (
    headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')
  ))) {
    return new GitHubError(429, 'GitHub’s request limit was reached.');
  }
  if (status === 401 || status === 403) return new GitHubError(403, 'GitHub or the Connector refused access.');
  if (status === 404) return new GitHubError(404, 'GitHub could not find that item.');
  if (status === 503) return new GitHubError(503, 'GitHub or the Connector is temporarily unavailable.');
  if (status === 504) return new GitHubError(504, 'The GitHub request took too long.');
  return new GitHubError(502, 'GitHub or the Connector could not complete the request.');
}

export function createGitHub({ gateway, fetchImpl = fetch }) {
  const base = gateway.replace(/\/$/, '');

  async function read(path) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ghostlight' },
        signal,
      });
    } catch {
      if (signal.aborted) throw new GitHubError(504, 'The GitHub request took too long.');
      throw new GitHubError(502, 'Ghostlight could not reach GitHub.');
    }
    if (!response.ok) {
      const error = responseError(response);
      await response.body?.cancel().catch(() => {});
      throw error;
    }

    try {
      return await response.json();
    } catch {
      if (signal.aborted) throw new GitHubError(504, 'The GitHub request took too long.');
      throw invalidResponse();
    }
  }

  async function list(path, limit) {
    const value = await read(path);
    if (!Array.isArray(value) || !value.every(isRecord)) throw invalidResponse();
    return value.slice(0, limit);
  }

  async function item(repo, collection, number) {
    const value = await read(itemPath(repo, collection, number));
    if (!isRecord(value) || value.number !== number) throw invalidResponse();
    return value;
  }

  return {
    /** @returns {Promise<{ issues: object[], comments: object[], pulls: object[] }>} Recent GitHub records. */
    async snapshot(repo) {
      const path = repositoryPath(repo);
      const [issues, comments, pulls] = await Promise.all([
        list(path + '/issues' + issueQuery, 30),
        list(path + '/issues/comments' + commentQuery, 50),
        list(path + '/pulls' + issueQuery, 30),
      ]);
      return { issues: issues.filter(row => !row.pull_request), comments, pulls };
    },
    /** @returns {Promise<object>} The GitHub pull request record. */
    pull(repo, number) {
      return item(repo, 'pulls', number);
    },
    /** @returns {Promise<object>} The GitHub issue or pull request’s conversation record. */
    issue(repo, number) {
      return item(repo, 'issues', number);
    },
    /** @returns {Promise<object[]>} Public events and cross-references for a known thread. */
    timeline(repo, number) {
      return list(itemPath(repo, 'issues', number) + '/timeline?per_page=60', 60);
    },
  };
}

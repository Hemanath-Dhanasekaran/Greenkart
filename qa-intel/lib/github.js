'use strict';

/**
 * Minimal GitHub REST client: pagination via Link headers, retries with
 * exponential backoff for network errors / 5xx / secondary rate limits, and
 * primary rate-limit awareness (waits briefly, otherwise reports clearly).
 * Uses the global fetch of Node 18+; no SDK dependency.
 */

const zlib = require('zlib');
const { sleep } = require('./util');

class GitHubError extends Error {
  constructor(message, { status, rateLimited, retryable } = {}) {
    super(message);
    this.status = status;
    this.rateLimited = Boolean(rateLimited);
    this.retryable = Boolean(retryable);
  }
}

function createGitHubClient({ token, repo, apiUrl = 'https://api.github.com', maxRetries = 4, maxRateLimitWaitMs = 90_000, fetchImpl = globalThis.fetch, log = () => {} }) {
  if (!repo) throw new Error('GitHub repository (owner/name) is required');
  const stats = { requests: 0, retries: 0, rateLimitRemaining: null };

  async function request(pathOrUrl, { raw = false, accept } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${apiUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const headers = { Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'qa-intel-collector' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        stats.requests++;
        res = await fetchImpl(url, { headers, redirect: 'follow' });
      } catch (err) {
        lastError = new GitHubError(`Network error calling ${url}: ${err.message}`, { retryable: true });
        stats.retries++;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining !== null) stats.rateLimitRemaining = Number(remaining);
      if (res.ok) return raw ? res : { data: await res.json(), headers: res.headers };

      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const body = await res.text().catch(() => '');
      const primaryLimited = (res.status === 403 || res.status === 429) && remaining === '0';
      const secondaryLimited = (res.status === 403 || res.status === 429) && /secondary rate limit|abuse/i.test(body);
      if (primaryLimited) {
        const waitMs = reset ? reset * 1000 - Date.now() + 1000 : Infinity;
        if (waitMs <= maxRateLimitWaitMs && attempt < maxRetries) {
          log(`GitHub rate limit reached; waiting ${Math.ceil(waitMs / 1000)}s`);
          await sleep(Math.max(0, waitMs));
          continue;
        }
        throw new GitHubError(`GitHub API rate limit exhausted${reset ? ` until ${new Date(reset * 1000).toISOString()}` : ''}${token ? '' : ' (no token: unauthenticated limit is 60 requests/hour)'}`, { status: res.status, rateLimited: true });
      }
      if (secondaryLimited || res.status === 429 || res.status >= 500) {
        lastError = new GitHubError(`GitHub API ${res.status} for ${url}`, { status: res.status, retryable: true, rateLimited: secondaryLimited });
        stats.retries++;
        await sleep(retryAfter ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** (attempt + 1)));
        continue;
      }
      throw new GitHubError(`GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`, { status: res.status });
    }
    throw lastError;
  }

  function nextLink(headers) {
    const link = headers.get('link');
    const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
    return m ? m[1] : null;
  }

  /** Follows rel="next" links; `pick` extracts the array from each page body. */
  async function paginate(path, { pick = (d) => d, maxPages = 10 } = {}) {
    const out = [];
    let url = path;
    for (let page = 0; url && page < maxPages; page++) {
      const { data, headers } = await request(url);
      out.push(...pick(data));
      url = nextLink(headers);
    }
    return out;
  }

  const r = `/repos/${repo}`;
  return {
    repo,
    stats,
    hasToken: Boolean(token),
    request,
    paginate,
    listRuns: ({ maxPages = 3, perPage = 100, status = 'completed' } = {}) => paginate(`${r}/actions/runs?per_page=${perPage}${status ? `&status=${status}` : ''}`, { pick: (d) => d.workflow_runs || [], maxPages }),
    getRun: (id) => request(`${r}/actions/runs/${id}`).then((x) => x.data),
    getRunAttempt: (id, attempt) => request(`${r}/actions/runs/${id}/attempts/${attempt}`).then((x) => x.data),
    listJobs: (id, attempt) => paginate(`${r}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`, { pick: (d) => d.jobs || [] }),
    listArtifacts: (id) => paginate(`${r}/actions/runs/${id}/artifacts?per_page=100`, { pick: (d) => d.artifacts || [] }),
    listCommits: (sha, maxPages = 5) => paginate(`${r}/commits?sha=${sha}&per_page=100`, { maxPages }),
    commitPulls: (sha) => request(`${r}/commits/${sha}/pulls`).then((x) => x.data),
    /** Downloads an artifact zip (token required, even for public repositories). */
    async downloadArtifact(id) {
      if (!token) throw new GitHubError('Downloading workflow artifacts requires a GitHub token', { status: 401 });
      const res = await request(`${r}/actions/artifacts/${id}/zip`, { raw: true });
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** Reads the entries of a (non-zip64) zip archive into memory. */
function unzip(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive (end of central directory not found)');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.slice(start, start + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

module.exports = { createGitHubClient, GitHubError, unzip };

'use strict';

/**
 * Append-only event history stored as JSONL files.
 *
 *   events/YYYY/MM/<batchId>.jsonl   one file per collection batch (never edited)
 *   index/index.json                 derived; rebuilt from events at any time
 *   meta.json                        store format / schema version
 *
 * Each collection job writes its own new batch file, so concurrent writers
 * never touch the same file. Event ids are deterministic, so re-collecting
 * the same commit or run is a no-op (duplicate prevention), and a batch file
 * is written atomically (temp file + rename), so an interrupted job leaves
 * either a complete batch or nothing.
 *
 * GitBranchStore keeps that directory on a dedicated orphan branch
 * (default "qa-history") through a git worktree, and retries pushes by
 * resetting to the remote and re-applying its events when another writer
 * pushed first.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SCHEMA_VERSION, COLLECTOR_VERSION, eventId, containsSecret, sanitizeDeep, sleep } = require('./util');
const { createGit } = require('./git');

const EVENT_TYPES = new Set([
  'commit.recorded',
  'test.added', 'test.modified', 'test.renamed', 'test.moved', 'test.deleted',
  'code.added', 'code.modified', 'code.renamed', 'code.deleted',
  'config.changed',
  'snapshot.baseline',
  'ci.run',
]);

function makeEvent({ type, naturalKey, occurredAt, repo, data, rank = 1, source }) {
  if (!EVENT_TYPES.has(type)) throw new Error(`Unknown event type ${type}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: eventId(type, `${repo}|${naturalKey}`),
    type,
    occurredAt,
    recordedAt: new Date().toISOString(),
    rank,
    source,
    collectorVersion: COLLECTOR_VERSION,
    repo,
    data,
  };
}

function validateEvent(e) {
  const problems = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  if (typeof e.schemaVersion !== 'number') problems.push('missing schemaVersion');
  else if (e.schemaVersion > SCHEMA_VERSION) problems.push(`schemaVersion ${e.schemaVersion} is newer than this tool supports (${SCHEMA_VERSION})`);
  if (!/^evt_[0-9a-f]{24}$/.test(e.id || '')) problems.push('invalid id');
  if (!EVENT_TYPES.has(e.type)) problems.push(`unknown type ${e.type}`);
  if (!e.occurredAt || Number.isNaN(Date.parse(e.occurredAt))) problems.push('invalid occurredAt');
  if (!e.data || typeof e.data !== 'object') problems.push('missing data');
  return problems;
}

/** Keeps the better of two events with the same id (higher rank, then newer). */
function preferEvent(a, b) {
  if (!a) return b;
  if ((b.rank || 0) !== (a.rank || 0)) return (b.rank || 0) > (a.rank || 0) ? b : a;
  return Date.parse(b.recordedAt) > Date.parse(a.recordedAt) ? b : a;
}

class FileStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  ensureLayout(repo) {
    fs.mkdirSync(path.join(this.dir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'index'), { recursive: true });
    const meta = path.join(this.dir, 'meta.json');
    if (!fs.existsSync(meta)) {
      fs.writeFileSync(meta, `${JSON.stringify({ format: 'qa-intel-history', schemaVersion: SCHEMA_VERSION, repo, createdAt: new Date().toISOString() }, null, 2)}\n`);
    }
    const readme = path.join(this.dir, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        '# QA Intelligence history',
        '',
        'Machine-written history of test, framework and CI/CD activity, maintained by',
        '`qa-intel/bin/qa-intel.js collect` (see qa-intel/README.md on the main branch).',
        '',
        '- `events/` — append-only JSONL event batches (source of truth, never edited)',
        '- `index/index.json` — derived index, rebuilt from events on every write',
        '- `dashboard/index.html` — self-contained dashboard built from the index',
        '',
        'Do not edit by hand. Delete `index/` and run `qa-intel index` to rebuild it.',
        '',
      ].join('\n'));
    }
  }

  eventFiles() {
    const root = path.join(this.dir, 'events');
    const out = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.jsonl')) out.push(full);
      }
    };
    walk(root);
    return out.sort();
  }

  /** All events, de-duplicated by id. Malformed or partial lines are skipped and counted. */
  loadEvents() {
    const byId = new Map();
    const stats = { files: 0, lines: 0, invalid: 0, duplicates: 0, problems: [] };
    for (const file of this.eventFiles()) {
      stats.files++;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        stats.lines++;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          stats.invalid++;
          stats.problems.push(`${path.relative(this.dir, file)}:${i + 1} is not valid JSON`);
          return;
        }
        const problems = validateEvent(e);
        if (problems.length) {
          stats.invalid++;
          stats.problems.push(`${path.relative(this.dir, file)}:${i + 1} ${problems.join('; ')}`);
          return;
        }
        if (byId.has(e.id)) stats.duplicates++;
        byId.set(e.id, preferEvent(byId.get(e.id), e));
      });
    }
    return { events: [...byId.values()], stats };
  }

  /**
   * Writes the events that are not already stored (or that improve on a
   * stored event's rank) as one new batch file per month.
   */
  append(events, { label = 'batch' } = {}) {
    const { events: existing } = this.loadEvents();
    const known = new Map(existing.map((e) => [e.id, e]));
    const fresh = [];
    const dropped = [];
    for (const raw of events) {
      const e = sanitizeDeep(raw);
      if (containsSecret(JSON.stringify(e))) {
        dropped.push(e.id);
        continue;
      }
      const old = known.get(e.id);
      if (old && (e.rank || 0) <= (old.rank || 0)) continue;
      known.set(e.id, e);
      fresh.push(e);
    }
    const byMonth = new Map();
    for (const e of fresh) {
      const month = e.occurredAt.slice(0, 7).replace('-', '/');
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(e);
    }
    const batchId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${label.replace(/[^a-z0-9-]/gi, '-').slice(0, 40)}-${crypto.randomBytes(3).toString('hex')}`;
    const written = [];
    for (const [month, list] of byMonth) {
      const dir = path.join(this.dir, 'events', month);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${batchId}.jsonl`);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${list.map((e) => JSON.stringify(e)).join('\n')}\n`);
      fs.renameSync(tmp, file);
      written.push(path.relative(this.dir, file));
    }
    return { written: fresh.length, skipped: events.length - fresh.length - dropped.length, droppedForSecrets: dropped.length, files: written };
  }

  writeJson(relPath, value) {
    const file = path.join(this.dir, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, file);
  }

  readJson(relPath) {
    const file = path.join(this.dir, relPath);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  /** Removes leftovers of an interrupted write. */
  cleanTemp() {
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.tmp')) fs.rmSync(full, { force: true });
      }
    };
    walk(this.dir);
  }
}

class GitBranchStore {
  constructor({ repoDir, branch = 'qa-history', remote = 'origin', dir, identity, log = () => {} }) {
    this.repoDir = path.resolve(repoDir);
    this.branch = branch;
    this.remote = remote;
    this.dir = path.resolve(dir || path.join(this.repoDir, '.qa-history'));
    this.identity = identity;
    this.log = log;
    this.git = createGit(this.repoDir);
    this.store = new FileStore(this.dir);
  }

  fetch() {
    return this.git.tryRun(['fetch', '--no-tags', this.remote, `+refs/heads/${this.branch}:refs/remotes/${this.remote}/${this.branch}`]) !== null;
  }

  remoteRef() {
    return this.git.resolve(`refs/remotes/${this.remote}/${this.branch}`);
  }

  /** Creates/refreshes the worktree so it matches the remote branch exactly. */
  prepare({ offline = false } = {}) {
    if (!offline) this.fetch();
    const remoteSha = this.remoteRef();
    const wt = createGit(this.dir);
    const isWorktree = fs.existsSync(path.join(this.dir, '.git'));
    if (!isWorktree) {
      this.git.tryRun(['worktree', 'prune']);
      if (fs.existsSync(this.dir) && fs.readdirSync(this.dir).length) throw new Error(`${this.dir} exists and is not a git worktree; remove it or pass --store-dir`);
      this.git.run(['worktree', 'add', '--force', '--detach', this.dir]);
    }
    if (remoteSha) {
      wt.run(['checkout', '-f', '-B', this.branch, remoteSha]);
    } else if (wt.resolve(`refs/heads/${this.branch}`)) {
      wt.run(['checkout', '-f', this.branch]);
    } else {
      wt.run(['checkout', '-f', '--orphan', this.branch]);
      wt.tryRun(['rm', '-rf', '--quiet', '.']);
    }
    wt.run(['clean', '-fdx']);
    this.store.cleanTemp();
    return { remoteSha, created: !remoteSha };
  }

  commit(message) {
    const wt = createGit(this.dir);
    wt.run(['add', '-A']);
    if (wt.tryRun(['diff', '--cached', '--quiet']) !== null) return false; // nothing staged
    const id = this.identity || { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
    wt.run(['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message]);
    return true;
  }

  push() {
    const wt = createGit(this.dir);
    try {
      wt.run(['push', '--quiet', this.remote, `HEAD:refs/heads/${this.branch}`]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.stderr || err.message).slice(0, 400) };
    }
  }

  /**
   * Runs writeFn(store) on top of the latest remote state, commits and pushes.
   * On a rejected push (another writer was first) it resets to the new remote
   * head and runs writeFn again, so no event is lost and none is duplicated.
   */
  async update(writeFn, { message, push = true, maxAttempts = 6 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.prepare();
      const result = await writeFn(this.store);
      const committed = this.commit(message || 'Update QA history');
      if (!committed) return { ...result, committed: false, pushed: false, attempts: attempt };
      if (!push) return { ...result, committed: true, pushed: false, attempts: attempt };
      const pushed = this.push();
      if (pushed.ok) return { ...result, committed: true, pushed: true, attempts: attempt };
      this.log(`Push of ${this.branch} rejected (attempt ${attempt}/${maxAttempts}); re-applying on top of the latest history. ${pushed.error}`);
      await sleep(500 * attempt + Math.floor(Math.random() * 1500));
    }
    throw new Error(`Could not push ${this.branch} after ${maxAttempts} attempts`);
  }
}

module.exports = { FileStore, GitBranchStore, makeEvent, validateEvent, preferEvent, EVENT_TYPES };

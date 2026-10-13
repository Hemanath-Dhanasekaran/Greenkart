'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { FileStore, GitBranchStore, makeEvent } = require('../lib/store');
const { tmpDir, git } = require('./helpers');

const ev = (key, extra = {}) => makeEvent({ type: 'commit.recorded', naturalKey: key, occurredAt: '2026-10-13T05:00:00.000Z', repo: 'o/r', source: 'test', data: { sha: key, subject: 's', ...extra } });

test('re-appending the same events is a no-op (duplicate prevention)', () => {
  const s = new FileStore(tmpDir());
  s.ensureLayout('o/r');
  assert.equal(s.append([ev('a'), ev('b')]).written, 2);
  const again = s.append([ev('a'), ev('b'), ev('c')]);
  assert.equal(again.written, 1);
  assert.equal(again.skipped, 2);
  assert.equal(s.loadEvents().events.length, 3);
});

test('an event with a better rank replaces an earlier, weaker copy', () => {
  const s = new FileStore(tmpDir());
  const weak = makeEvent({ type: 'ci.run', naturalKey: '1|1', occurredAt: '2026-10-13T05:00:00.000Z', repo: 'o/r', rank: 1, data: { runId: 1, attempt: 1, tests: { available: false } } });
  const strong = makeEvent({ type: 'ci.run', naturalKey: '1|1', occurredAt: '2026-10-13T05:00:00.000Z', repo: 'o/r', rank: 3, data: { runId: 1, attempt: 1, tests: { available: true } } });
  assert.equal(weak.id, strong.id);
  s.append([weak]);
  assert.equal(s.append([weak]).written, 0);
  assert.equal(s.append([strong]).written, 1);
  const { events, stats } = s.loadEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].data.tests.available, true);
  assert.equal(stats.duplicates, 1);
});

test('partial or corrupt lines from an interrupted write are skipped and reported', () => {
  const dir = tmpDir();
  const s = new FileStore(dir);
  s.append([ev('a')]);
  fs.appendFileSync(s.eventFiles()[0], '{"schemaVersion":1,"id":"evt_trunc');
  fs.writeFileSync(path.join(dir, 'events', '2026', '10', 'leftover.jsonl.tmp'), 'garbage');
  const { events, stats } = s.loadEvents();
  assert.equal(events.length, 1);
  assert.equal(stats.invalid, 1);
  s.cleanTemp();
  assert.ok(!fs.existsSync(path.join(dir, 'events', '2026', '10', 'leftover.jsonl.tmp')));
});

test('secrets are redacted before storage', () => {
  const s = new FileStore(tmpDir());
  s.append([ev('x', { subject: 'use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password=hunter2' })]);
  const raw = fs.readFileSync(s.eventFiles()[0], 'utf8');
  assert.ok(!raw.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(!raw.includes('hunter2'));
});

function remoteWithClone() {
  const remote = tmpDir('qa-intel-remote-');
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  const seed = tmpDir('qa-intel-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', 'origin', 'main']);
  const clone = () => {
    const d = tmpDir('qa-intel-clone-');
    git(d, ['clone', '-q', remote, '.']);
    return d;
  };
  return { remote, clone };
}

const identity = { name: 'qa-bot', email: 'qa-bot@example.com' };

test('history persists on the data branch across fresh runners', async () => {
  const { remote, clone } = remoteWithClone();
  const a = new GitBranchStore({ repoDir: clone(), identity });
  const res = await a.update((store) => {
    store.ensureLayout('o/r');
    return store.append([ev('a'), ev('b')]);
  }, { message: 'first' });
  assert.equal(res.pushed, true);
  assert.equal(git(remote, ['log', '--format=%s', 'qa-history']), 'first');
  assert.equal(git(remote, ['log', '--format=%s', 'main']), 'init', 'source branch untouched');

  const fresh = new GitBranchStore({ repoDir: clone(), identity });
  fresh.prepare();
  assert.deepEqual(fresh.store.loadEvents().events.map((e) => e.data.sha).sort(), ['a', 'b']);
});

test('a rejected push is retried on top of the other writer, without loss or duplicates', async () => {
  const { remote, clone } = remoteWithClone();
  const a = new GitBranchStore({ repoDir: clone(), identity });
  const b = new GitBranchStore({ repoDir: clone(), identity, log: () => {} });
  let raced = false;
  const res = await b.update(async (store) => {
    store.ensureLayout('o/r');
    if (!raced) {
      raced = true; // another runner pushes between B's read and B's push
      await a.update((sa) => { sa.ensureLayout('o/r'); return sa.append([ev('from-a'), ev('shared')]); }, { message: 'a' });
    }
    return store.append([ev('from-b'), ev('shared')]);
  }, { message: 'b' });
  assert.equal(res.pushed, true);
  assert.equal(res.attempts, 2);
  const check = new GitBranchStore({ repoDir: clone(), identity });
  check.prepare();
  const shas = check.store.loadEvents().events.map((e) => e.data.sha).sort();
  assert.deepEqual(shas, ['from-a', 'from-b', 'shared']);
  assert.match(git(remote, ['log', '--format=%s', 'qa-history']), /^b\na$/);
});

test('parallel writer processes all land safely', { timeout: 120000 }, async () => {
  const { clone } = remoteWithClone();
  const script = `
    const { GitBranchStore, makeEvent } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store.js'))});
    const id = process.argv[1];
    const s = new GitBranchStore({ repoDir: process.cwd(), identity: { name: 'w', email: 'w@e' }, log: () => {} });
    s.update((store) => { store.ensureLayout('o/r'); return store.append([
      makeEvent({ type: 'commit.recorded', naturalKey: 'w' + id, occurredAt: '2026-10-13T05:00:00.000Z', repo: 'o/r', data: { sha: 'w' + id } }),
      makeEvent({ type: 'commit.recorded', naturalKey: 'common', occurredAt: '2026-10-13T05:00:00.000Z', repo: 'o/r', data: { sha: 'common' } }),
    ]); }, { message: 'writer ' + id, maxAttempts: 10 }).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
  `;
  const dirs = [clone(), clone(), clone()];
  const codes = await Promise.all(dirs.map((d, i) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script, String(i)], { cwd: d, stdio: 'ignore' });
    p.on('exit', resolve);
  })));
  assert.deepEqual(codes, [0, 0, 0]);
  const check = new GitBranchStore({ repoDir: clone(), identity });
  check.prepare();
  const shas = check.store.loadEvents().events.map((e) => e.data.sha).sort();
  assert.deepEqual(shas, ['common', 'w0', 'w1', 'w2']);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { collect } = require('../lib/collector');
const { FileStore } = require('../lib/store');
const { buildIndex } = require('../lib/indexer');
const { ask, interpret } = require('../lib/query');
const { makeRepo, tmpDir, SPEC_V1, PAGE_V1, FIXTURE_V1, minimalRun, job } = require('./helpers');

/** Minimal stored (uncompressed) zip, as GitHub serves artifacts. */
function zip(name, content) {
  const data = Buffer.from(content);
  const nameBuf = Buffer.from(name);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  const cdOffset = local.length + nameBuf.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

const KEY_ADD = 'tests/cart.spec.js::Cart > adds a product @smoke';
const KEY_TOTALS = 'tests/cart.spec.js::Cart > checks totals';
const result = (key, outcome, extra = {}) => ({ key, file: 'tests/cart.spec.js', title: key.split(' > ').pop(), titlePath: key.split('::')[1].split(' > '), outcome, retries: outcome === 'flaky' ? 1 : 0, durationMs: 1000, attempts: [], error: outcome === 'failed' ? { summary: 'Expected "10" but received "12"' } : null, ...extra });
function resultsFile(runId, tests) {
  const counts = { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0, timedOut: 0, interrupted: 0, notRun: 0 };
  tests.forEach((t) => counts[t.outcome]++);
  return JSON.stringify({ format: 'qa-intel-run-results/1', github: { runId, runAttempt: 1, schedule: null }, results: { available: true, source: 'playwright-json', fidelity: 'full', counts, globalErrors: [], tests } });
}

const OK_STEPS = [['Set up job', 'success'], ['Install dependencies', 'success'], ['Run Playwright tests', 'success'], ['Summarize test results for QA history', 'success']];
const FAIL_TESTS = [['Set up job', 'success'], ['Install dependencies', 'success'], ['Run Playwright tests', 'failure'], ['Summarize test results for QA history', 'success']];
const FAIL_NPM = [['Set up job', 'success'], ['Install dependencies', 'failure'], ['Run Playwright tests', 'skipped'], ['Summarize test results for QA history', 'success']];

function fakeGitHub(runs) {
  const byId = new Map(runs.map((r) => [r.run.id, r]));
  const stats = { requests: 0, retries: 0, rateLimitRemaining: 1000 };
  return {
    hasToken: true,
    stats,
    listRuns: async () => runs.map((r) => r.run),
    getRun: async (id) => byId.get(Number(id)).run,
    getRunAttempt: async (id) => byId.get(Number(id)).run,
    listJobs: async (id) => byId.get(Number(id)).jobs,
    listArtifacts: async (id) => (byId.get(Number(id)).artifact ? [{ id: id * 10, name: 'qa-intel-results-attempt-1', expired: false, size_in_bytes: 100, expires_at: '2027-01-01T00:00:00Z' }] : []),
    downloadArtifact: async (artifactId) => zip('run-results.json', byId.get(artifactId / 10).artifact),
    listCommits: async () => [],
    commitPulls: async (sha) => (sha.startsWith(PR_SHA_PREFIX.value) ? [{ number: 7, title: 'Change totals', html_url: 'https://github.com/o/r/pull/7', state: 'closed', merged_at: '2026-10-05T00:00:00Z' }] : []),
  };
}
const PR_SHA_PREFIX = { value: '~' };

async function scenario() {
  const r = makeRepo();
  r.write('tests/cart.spec.js', SPEC_V1);
  r.write('Pages/HomePage.js', PAGE_V1);
  r.write('utils/baseTest.js', FIXTURE_V1);
  const c1 = r.commit('Initial framework', '2026-10-05T10:00:00+05:30');
  r.write('Pages/HomePage.js', PAGE_V1.replace("await this.page.click('text=' + name);", "await this.page.dblclick('text=' + name);"));
  const c2 = r.commit('Change addToCart click', '2026-10-06T10:00:00+05:30');
  PR_SHA_PREFIX.value = c2.slice(0, 10);
  r.write('Pages/HomePage.js', PAGE_V1.replace("await this.page.click('text=' + name);", "await this.page.dblclick('text=' + name);").replace('async unused() { return 1; }', 'async unused() { return 1; }\n\n  async helperNew() { return 2; }'));
  const c3 = r.commit('Add helper', '2026-10-07T10:00:00+05:30');

  const run = (id, sha, event, at, conclusion) => minimalRun({ id, run_number: id, head_sha: sha, event, conclusion, created_at: at, run_started_at: at, updated_at: at, html_url: `https://github.com/o/r/actions/runs/${id}` });
  const runs = [
    { run: run(1, c1, 'push', '2026-10-05T05:00:00Z', 'success'), jobs: [job(OK_STEPS, { completed_at: '2026-10-05T05:05:00Z' })], artifact: resultsFile(1, [result(KEY_ADD, 'passed'), result(KEY_TOTALS, 'passed')]) },
    { run: run(2, c2, 'push', '2026-10-06T05:00:00Z', 'failure'), jobs: [job(FAIL_TESTS, { completed_at: '2026-10-06T05:05:00Z' })], artifact: resultsFile(2, [result(KEY_ADD, 'passed'), result(KEY_TOTALS, 'failed')]) },
    { run: run(3, c2, 'schedule', '2026-10-06T22:00:00Z', 'failure'), jobs: [job(FAIL_TESTS, { completed_at: '2026-10-06T22:05:00Z' })], artifact: resultsFile(3, [result(KEY_ADD, 'flaky'), result(KEY_TOTALS, 'failed')]) },
    { run: run(4, c3, 'schedule', '2026-10-07T22:00:00Z', 'failure'), jobs: [job(FAIL_NPM, { completed_at: '2026-10-07T22:02:00Z' })], artifact: null },
  ];
  const store = new FileStore(tmpDir());
  store.ensureLayout('o/r');
  const out = await collect({ repoDir: r.dir, repo: 'o/r', github: fakeGitHub(runs), existingEvents: [], refs: [{ ref: 'HEAD', branch: 'main' }], maxRuns: 50 });
  store.append(out.events);
  const { events } = store.loadEvents();
  return { repo: r, c1, c2, c3, store, events, index: buildIndex(events, { repo: 'o/r' }), github: fakeGitHub(runs) };
}

const NOW = '2026-10-08T12:00:00+05:30';

test('commit → method → test → run → result traceability', async () => {
  const { index, c1, c2, c3 } = await scenario();
  assert.equal(index.totals.commits, 3);
  assert.equal(index.totals.runs, 4);
  assert.equal(index.totals.runsWithResults, 3);

  const addToCart = index.codeChanges.find((c) => c.qualifiedName === 'HomePage.addToCart' && c.sha === c2);
  assert.ok(addToCart, 'method change recorded');
  assert.deepEqual(addToCart.impact.tests.map((t) => t.testKey), [KEY_TOTALS]);
  assert.equal(addToCart.coverage.status, 'failing', 'linked test ran after the change but did not pass');
  assert.deepEqual(addToCart.pullRequests.map((p) => p.number), [7]);

  const open = index.codeChanges.find((c) => c.qualifiedName === 'HomePage.open' && c.sha === c1);
  assert.equal(open.coverage.status, 'verified');
  assert.equal(open.coverage.run.runId, 1);

  const helper = index.codeChanges.find((c) => c.qualifiedName === 'HomePage.helperNew');
  assert.equal(helper.sha, c3);
  assert.equal(helper.coverage.status, 'no-linked-tests');

  // Runs executed against each commit
  assert.deepEqual(index.runs.filter((r) => r.sha === c2).map((r) => r.runId).sort(), [2, 3]);
  const tests = Object.values(index.tests);
  assert.equal(tests.length, 2);
  assert.equal(index.tests[index.keyToId[KEY_TOTALS]].lastResult.outcome, 'failed');
});

test('insights: new failure, its likely commit, repeats, flaky, pipeline failure', async () => {
  const { index, c2 } = await scenario();
  const nf = index.insights.newFailures.find((f) => f.key === KEY_TOTALS);
  assert.ok(nf);
  assert.equal(nf.lastPass.runId, 1);
  assert.equal(nf.run.runId, 2);
  const cand = nf.candidateCommits.find((c) => c.sha === c2);
  assert.ok(cand.links.some((l) => l.strength === 'static-link' && /HomePage\.addToCart/.test(l.text)));
  assert.ok(index.insights.repeatedFailures.some((f) => f.key === KEY_TOTALS && f.count === 2));
  assert.ok(index.insights.flaky.some((f) => f.key === KEY_ADD && f.confidence === 'confirmed'));
  assert.deepEqual(index.insights.pipelineFailures.map((p) => [p.runId, p.category]), [[4, 'dependency-install-failed']]);
  assert.ok(index.insights.coverageGaps.some((g) => g.qualifiedName === 'HomePage.helperNew' && g.status === 'no-linked-tests'));
});

test('natural-language answers are deterministic and evidence-backed', async () => {
  const { index, c2 } = await scenario();
  const origin = ask(index, 'Which commit introduced this failure?', { now: NOW });
  assert.equal(origin.intent, 'failure-origin');
  assert.match(origin.headline, new RegExp(`Most likely related commit: ${c2.slice(0, 7)}`));
  assert.ok(origin.notes.some((n) => /not proof/.test(n)));

  const sched = ask(index, 'What happened in the latest scheduled run?', { now: NOW });
  assert.equal(sched.intent, 'run-detail');
  assert.match(sched.headline, /Dependency installation failed before tests ran/);
  assert.ok(sched.missing.some((m) => /not zero/.test(m)) || sched.sections[0].items[0].lines.some((l) => /not a test failure/.test(l)));

  const cmp = ask(index, 'Compare the latest scheduled run with the previous scheduled run', { now: NOW });
  assert.equal(cmp.intent, 'compare-runs');
  assert.match(cmp.headline, /Test-level comparison is not possible/);

  const fails = ask(index, 'What tests failed in the last five executions?', { now: NOW });
  assert.equal(fails.intent, 'recent-failures');
  assert.match(fails.headline, /^1 test failed in the last 4 executions \(2 failures in total\)/);
  assert.ok(fails.points.some((p) => /failed before tests ran/.test(p)));

  const methods = ask(index, 'What methods were added or modified yesterday?', { now: '2026-10-08T12:00:00+05:30' });
  assert.equal(methods.intent, 'code-changes');
  assert.equal(methods.range.description, 'Wed 7 Oct 2026 (00:00–23:59 IST)');
  assert.deepEqual(methods.sections[0].items.map((i) => i.title), ['HomePage.helperNew']);

  const gaps = ask(index, 'Which changed methods have not been covered by a successful relevant test run?', { now: NOW });
  assert.equal(gaps.intent, 'coverage-gaps');
  assert.ok(gaps.sections[0].items.some((i) => i.title === 'HomePage.addToCart'));
  assert.ok(gaps.sections[0].items.some((i) => i.title === 'HomePage.helperNew'));

  const commit = ask(index, `Show all QA activities for commit ${c2.slice(0, 8)}`, { now: NOW });
  assert.equal(commit.intent, 'commit');
  assert.match(commit.headline, /2 runs executed against it/);

  const week = ask(index, "Summarize this week's automation progress", { now: NOW });
  assert.equal(week.intent, 'summary');
  assert.match(week.headline, /3 commits, 2 tests added/);

  const none = ask(index, 'What test cases were deleted this month?', { now: NOW });
  assert.match(none.headline, /^No test cases were deleted this month/);
});

test('intent routing for the documented example questions', () => {
  const now = new Date(NOW);
  const cases = {
    'What test cases were added two days ago?': 'test-changes',
    'What tests were added this week?': 'test-changes',
    'What methods were added or modified yesterday?': 'code-changes',
    'What framework changes happened in the last seven days?': 'code-changes',
    'What test cases were deleted this month?': 'test-changes',
    'What happened in the latest scheduled run?': 'run-detail',
    'What tests failed in the last five executions?': 'recent-failures',
    'Which commit introduced this failure?': 'failure-origin',
    'Which changed methods have not been covered by a successful relevant test run?': 'coverage-gaps',
    'Show all QA activities for commit 5fb38c6': 'commit',
    "Summarize this week's automation progress": 'summary',
    'Compare the latest scheduled run with the previous scheduled run': 'compare-runs',
    'Which tests are flaky?': 'insights',
    'Show manual runs this week': 'runs',
  };
  for (const [q, intent] of Object.entries(cases)) assert.equal(interpret(q, now).intent, intent, q);
  assert.equal(interpret('What tests failed in the last five executions?', now).ctx.count, 5);
  assert.equal(interpret('latest scheduled run', now).ctx.event, 'schedule');
});

test('collection is idempotent and resumable', async () => {
  const { repo, store, events, github } = await scenario();
  const again = await collect({ repoDir: repo.dir, repo: 'o/r', github, existingEvents: events, refs: [{ ref: 'HEAD', branch: 'main' }] });
  assert.equal(again.events.length, 0, 'nothing new on a repeated collection');
  // a new commit after an interrupted job is picked up on the next run
  repo.write('tests/new.spec.js', "const { test } = require('@playwright/test');\ntest('brand new', async () => {});\n");
  repo.commit('add test', '2026-10-08T09:00:00+05:30');
  const next = await collect({ repoDir: repo.dir, repo: 'o/r', github, existingEvents: events, refs: [{ ref: 'HEAD', branch: 'main' }] });
  assert.deepEqual(next.events.map((e) => e.type).sort(), ['commit.recorded', 'test.added']);
  assert.equal(store.append(next.events).written, 2);
  assert.equal(store.append(next.events).written, 0);
});

test('index rebuild is deterministic and independent of event order', async () => {
  const { events } = await scenario();
  const strip = (i) => JSON.stringify({ ...i, builtAt: null });
  const at = new Date('2026-10-08T00:00:00Z');
  assert.equal(strip(buildIndex(events, { now: at })), strip(buildIndex([...events].reverse(), { now: at })));
});

test('dashboard figures match the index', async () => {
  const { index } = await scenario();
  const { buildDashboardHtml } = require('../lib/dashboard');
  const html = buildDashboardHtml(index);
  const m = html.match(/<script>window\.QA_INDEX = (.*?);<\/script>/s);
  assert.ok(m, 'index embedded');
  assert.ok(!/<\/script/i.test(m[1]));
  const embedded = JSON.parse(m[1]);
  assert.deepEqual(embedded.totals, index.totals);
  assert.equal(embedded.runs.length, 4);
});

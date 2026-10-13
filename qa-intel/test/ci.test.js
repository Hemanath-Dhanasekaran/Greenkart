'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { classifyRun, buildRunRecord, stageOfStep } = require('../lib/ci');
const { fromPlaywrightJson, fromAllureResults } = require('../lib/results');
const { minimalRun, job, tmpDir } = require('./helpers');

const STEPS = ['Set up job', 'Checkout code', 'Set up Node.js', 'Set up Java (required by Allure CLI)', 'Install dependencies', 'Install Playwright browsers', 'Run Playwright tests', 'Summarize test results for QA history', 'Upload QA history results', 'Upload Playwright HTML report', 'Generate standalone Allure report', 'Upload Allure report', 'Complete job'];
const steps = (failAt, { cancelAt, skipAfter = true } = {}) => STEPS.map((name, i) => {
  const at = STEPS.indexOf(failAt);
  const c = STEPS.indexOf(cancelAt);
  if (name === failAt) return [name, 'failure'];
  if (name === cancelAt) return [name, 'cancelled'];
  if (skipAfter && ((at >= 0 && i > at && !/QA history|Upload|Complete/.test(name)) || (c >= 0 && i > c))) return [name, 'skipped'];
  return [name, 'success'];
});
const results = (counts) => ({ available: true, counts: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, timedOut: 0, interrupted: 0, notRun: 0, ...counts }, tests: [] });
const missing = { available: false, reason: 'the run uploaded no test-results artifact' };

test('step names map to pipeline stages', () => {
  assert.equal(stageOfStep('Set up Java (required by Allure CLI)'), 'setup');
  assert.equal(stageOfStep('Install dependencies'), 'dependency-install');
  assert.equal(stageOfStep('Install Playwright browsers'), 'browser-install');
  assert.equal(stageOfStep('Run Playwright tests'), 'tests');
  assert.equal(stageOfStep('Upload Playwright HTML report'), 'reporting');
  assert.equal(stageOfStep('Generate standalone Allure report'), 'reporting');
  assert.equal(stageOfStep('Summarize test results for QA history'), 'history');
  assert.equal(stageOfStep('Post Set up Node.js'), 'teardown');
});

test('dependency installation failure is not a test failure', () => {
  const c = classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Install dependencies'))], results: missing });
  assert.equal(c.category, 'dependency-install-failed');
  assert.equal(c.testsExecuted, false);
  assert.match(c.notes.join(' '), /not a test failure/);
});

test('setup and browser-install failures are classified by stage', () => {
  assert.equal(classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Checkout code'))], results: missing }).category, 'setup-failed');
  assert.equal(classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Install Playwright browsers'))], results: missing }).category, 'browser-install-failed');
  assert.equal(classifyRun({ run: minimalRun({ conclusion: 'startup_failure' }), jobs: [], results: missing }).category, 'workflow-error');
});

test('failing tests are tests-failed; missing results are never zero failures', () => {
  const failed = classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Run Playwright tests'))], results: results({ total: 3, passed: 2, failed: 1 }) });
  assert.equal(failed.category, 'tests-failed');
  assert.equal(failed.testsExecuted, true);
  const noRes = classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Run Playwright tests'))], results: missing });
  assert.equal(noRes.category, 'tests-step-failed-no-results');
  assert.equal(noRes.testsExecuted, 'unknown');
  const ok = classifyRun({ run: minimalRun(), jobs: [job(steps(null))], results: missing });
  assert.equal(ok.category, 'succeeded-results-missing');
  assert.match(ok.notes.join(' '), /unknown — not zero/);
  const empty = classifyRun({ run: minimalRun(), jobs: [job(steps(null))], results: results({ total: 0 }) });
  assert.equal(empty.category, 'succeeded-results-missing');
});

test('passing, flaky, reporting-failure and history-failure outcomes', () => {
  assert.equal(classifyRun({ run: minimalRun(), jobs: [job(steps(null))], results: results({ total: 2, passed: 2 }) }).category, 'passed');
  assert.equal(classifyRun({ run: minimalRun(), jobs: [job(steps(null))], results: results({ total: 2, passed: 1, flaky: 1 }) }).category, 'passed-with-flaky');
  const rep = classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Upload Allure report', { skipAfter: false }))], results: results({ total: 2, passed: 2 }) });
  assert.equal(rep.category, 'reporting-failed');
  assert.equal(rep.failureStage, 'reporting');
  const both = classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Generate standalone Allure report', { skipAfter: false }))], results: results({ total: 2, passed: 1, failed: 1 }) });
  assert.equal(both.category, 'tests-failed');
  const hist = classifyRun({ run: minimalRun({ conclusion: 'failure' }), jobs: [job(steps('Summarize test results for QA history', { skipAfter: false }))], results: results({ total: 2, passed: 2 }) });
  assert.equal(hist.category, 'history-failed');
});

test('cancelled and timed-out runs', () => {
  const c = classifyRun({ run: minimalRun({ conclusion: 'cancelled' }), jobs: [job(steps(null, { cancelAt: 'Run Playwright tests' }), { conclusion: 'cancelled' })], results: missing });
  assert.equal(c.category, 'cancelled');
  assert.equal(c.failureStage, 'tests');
  const t = classifyRun({ run: minimalRun({ conclusion: 'timed_out' }), jobs: [], results: missing });
  assert.equal(t.category, 'timed-out');
  // A job cancelled after running for its whole timeout-minutes is a timeout (inferred).
  const inferred = classifyRun({
    run: minimalRun({ conclusion: 'cancelled' }),
    jobs: [job(steps(null, { cancelAt: 'Run Playwright tests' }), { conclusion: 'cancelled', started_at: '2026-10-13T03:00:00Z', completed_at: '2026-10-13T04:00:05Z' })],
    results: missing,
    jobTimeouts: { 'Run Playwright tests': 60 },
  });
  assert.equal(inferred.category, 'timed-out');
  assert.match(inferred.notes.join(' '), /inferred timeout/);
});

test('run record keeps trigger, timing, counts and report links', () => {
  const rec = buildRunRecord({
    repo: 'o/r',
    run: minimalRun({ event: 'schedule' }),
    jobs: [job(steps(null))],
    artifacts: [
      { id: 5, name: 'playwright-report', size_in_bytes: 10, expires_at: '2026-11-12T00:00:00Z', expired: false },
      { id: 6, name: 'allure-report', size_in_bytes: 10, expires_at: '2026-10-01T00:00:00Z', expired: false },
    ],
    results: results({ total: 1, passed: 1 }),
    resultsMeta: { schedule: '30 3 * * *' },
    now: new Date('2026-10-13T12:00:00Z'),
  });
  assert.equal(rec.isScheduled, true);
  assert.equal(rec.scheduleCron, '30 3 * * *');
  assert.equal(rec.durationSec, 585);
  assert.equal(rec.reports.playwrightReport.url, 'https://github.com/o/r/actions/runs/1001/artifacts/5');
  assert.equal(rec.reports.allureReport.expired, true);
  assert.equal(rec.classification.category, 'passed');
});

test('Playwright JSON: retries, flaky, timed out, skipped, sanitised errors', () => {
  const root = path.resolve('/repo/tests');
  const json = {
    config: { rootDir: root },
    stats: { startTime: '2026-10-13T03:30:00.000Z', duration: 1234.5, expected: 1, unexpected: 2, flaky: 1, skipped: 1 },
    errors: [],
    suites: [{
      title: 'a.spec.js', file: 'a.spec.js', specs: [],
      suites: [{
        title: 'Cart', file: 'a.spec.js',
        specs: [
          { title: 'ok', file: 'a.spec.js', line: 3, tests: [{ status: 'expected', results: [{ status: 'passed', retry: 0, duration: 100 }] }] },
          { title: 'flaky', file: 'a.spec.js', line: 4, tests: [{ status: 'flaky', results: [{ status: 'failed', retry: 0, duration: 50, error: { message: 'boom' } }, { status: 'passed', retry: 1, duration: 60 }] }] },
          { title: 'slow', file: 'a.spec.js', line: 5, tests: [{ status: 'unexpected', results: [{ status: 'timedOut', retry: 0, duration: 120000, error: { message: 'Test timeout of 120000ms exceeded.' } }, { status: 'timedOut', retry: 1, duration: 120000, error: { message: 'Test timeout of 120000ms exceeded.' } }] }] },
          { title: 'bad', file: 'a.spec.js', line: 6, tests: [{ status: 'unexpected', results: [{ status: 'failed', retry: 0, duration: 10, error: { message: '\u001b[31mExpected 1\u001b[39m at https://x.test/?token=abc123secret password=hunter2' } }] }] },
          { title: 'skip', file: 'a.spec.js', line: 7, tests: [{ status: 'skipped', results: [{ status: 'skipped', retry: 0, duration: 0 }] }] },
        ],
      }],
    }],
  };
  const r = fromPlaywrightJson(json, path.resolve('/repo'));
  assert.deepEqual(r.counts, { total: 5, passed: 1, failed: 1, flaky: 1, skipped: 1, timedOut: 1, interrupted: 0, notRun: 0 });
  const by = Object.fromEntries(r.tests.map((t) => [t.title, t]));
  assert.equal(by.flaky.retries, 1);
  assert.equal(by.slow.outcome, 'timedOut');
  assert.equal(by.ok.key, 'tests/a.spec.js::Cart > ok');
  assert.ok(!/\u001b/.test(by.bad.error.message));
  assert.ok(!/abc123secret|hunter2/.test(by.bad.error.message), by.bad.error.message);
});

test('Allure fallback groups retries by title', () => {
  const mk = (status, start) => ({ name: 'retry me', status, start, stop: start + 10, titlePath: ['pkg', 'a.spec.js', 'Cart'], labels: [] });
  const r = fromAllureResults([mk('failed', 1), mk('passed', 100)], 'tests');
  assert.equal(r.tests[0].outcome, 'flaky');
  assert.equal(r.tests[0].key, 'tests/a.spec.js::Cart > retry me');
  assert.equal(r.fidelity, 'partial');
});

test('extract-results writes an explicit "unavailable" file when the report is missing', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'run-results.json');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'qa-intel.js'), 'extract-results', '--input', path.join(dir, 'nope.json'), '--output', out], { stdio: 'ignore', env: { ...process.env, GITHUB_RUN_ID: '42' } });
  const file = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(file.format, 'qa-intel-run-results/1');
  assert.equal(file.github.runId, 42);
  assert.equal(file.results.available, false);
  assert.match(file.results.reason, /not found/);
});

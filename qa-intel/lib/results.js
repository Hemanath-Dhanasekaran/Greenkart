'use strict';

/**
 * Normalises Playwright test outcomes into one shape, from either the
 * Playwright JSON reporter (preferred: has retries and per-attempt status) or
 * raw allure-results files (fallback for runs recorded before the JSON
 * reporter existed). Only titles, statuses, durations and short sanitised
 * error messages are kept — no stdout, attachments, host names or test data.
 */

const path = require('path');
const { sanitizeText } = require('./util');

const RESULTS_FORMAT = 'qa-intel-run-results/1';

function emptyCounts() {
  return { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, timedOut: 0, interrupted: 0, notRun: 0 };
}

function countOutcomes(tests) {
  const c = emptyCounts();
  for (const t of tests) {
    c.total++;
    if (t.outcome in c) c[t.outcome]++;
  }
  return c;
}

function errorSummary(err) {
  if (!err) return null;
  const message = sanitizeText(err.message || err.value || String(err), 500);
  const firstLine = message ? message.split('\n').find((l) => l.trim()) || message : null;
  const loc = err.location ? `${path.basename(err.location.file || '')}:${err.location.line}` : undefined;
  return { summary: firstLine ? sanitizeText(firstLine, 200) : null, message, location: loc };
}

const toPosix = (p) => p.split(path.sep).join('/').replace(/\\/g, '/');

/**
 * @param json      parsed output of Playwright's JSON reporter
 * @param repoRoot  absolute path of the repository root (to make spec paths repo-relative)
 */
function fromPlaywrightJson(json, repoRoot) {
  const rootDir = (json.config && json.config.rootDir) || repoRoot;
  const tests = [];

  function visit(suite, titles, isFileSuite) {
    const nextTitles = isFileSuite ? titles : suite.title ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      const file = toPosix(path.relative(repoRoot, path.resolve(rootDir, spec.file || suite.file || '')));
      for (const t of spec.tests || []) {
        const results = t.results || [];
        const last = results[results.length - 1];
        let outcome;
        if (t.status === 'flaky') outcome = 'flaky';
        else if (t.status === 'skipped') outcome = results.length ? 'skipped' : 'notRun';
        else if (t.status === 'expected') outcome = last && last.status === 'skipped' ? 'skipped' : 'passed';
        else if (last && last.status === 'timedOut') outcome = 'timedOut';
        else if (last && last.status === 'interrupted') outcome = 'interrupted';
        else outcome = results.length ? 'failed' : 'notRun';
        const failing = [...results].reverse().find((r) => r.status !== 'passed' && r.status !== 'skipped' && (r.error || (r.errors && r.errors.length)));
        const titlePath = [...nextTitles, spec.title];
        tests.push({
          key: `${file}::${titlePath.join(' > ')}`,
          file,
          title: spec.title,
          titlePath,
          project: t.projectName || null,
          line: spec.line,
          tags: spec.tags || [],
          outcome,
          expectedStatus: t.expectedStatus,
          retries: Math.max(0, results.length - 1),
          durationMs: results.reduce((s, r) => s + (r.duration || 0), 0),
          attempts: results.map((r) => ({ retry: r.retry, status: r.status, durationMs: r.duration, startTime: r.startTime })),
          error: failing ? errorSummary(failing.error || failing.errors[0]) : null,
        });
      }
    }
    for (const child of suite.suites || []) visit(child, nextTitles, false);
  }
  for (const fileSuite of json.suites || []) visit(fileSuite, [], true);

  const globalErrors = (json.errors || []).map(errorSummary).filter(Boolean);
  const counts = countOutcomes(tests);
  return {
    available: true,
    source: 'playwright-json',
    fidelity: 'full',
    startedAt: json.stats && json.stats.startTime ? new Date(json.stats.startTime).toISOString() : null,
    durationMs: json.stats ? Math.round(json.stats.duration) : null,
    counts,
    playwrightStats: json.stats ? { expected: json.stats.expected, unexpected: json.stats.unexpected, flaky: json.stats.flaky, skipped: json.stats.skipped } : null,
    globalErrors,
    tests,
  };
}

/**
 * @param files    array of parsed *-result.json objects from allure-results
 * @param testDir  repo-relative Playwright testDir, e.g. "tests"
 */
function fromAllureResults(files, testDir = 'tests') {
  const groups = new Map();
  for (const r of files) {
    if (!r || !r.name) continue;
    const tp = Array.isArray(r.titlePath) ? r.titlePath : [];
    const specFile = tp[1] || ((r.labels || []).find((l) => l.name === 'suite') || {}).value || '';
    const describes = tp.slice(2);
    const file = toPosix(path.posix.join(testDir.replace(/^\.\//, ''), specFile));
    const titlePath = [...describes, r.name];
    const key = `${file}::${titlePath.join(' > ')}`;
    if (!groups.has(key)) groups.set(key, { key, file, title: r.name, titlePath, attempts: [] });
    groups.get(key).attempts.push(r);
  }
  const tests = [];
  for (const g of groups.values()) {
    g.attempts.sort((a, b) => (a.start || 0) - (b.start || 0));
    const statuses = g.attempts.map((a) => a.status);
    const last = g.attempts[g.attempts.length - 1];
    let outcome;
    if (last.status === 'passed') outcome = statuses.some((s) => s === 'failed' || s === 'broken') ? 'flaky' : 'passed';
    else if (last.status === 'skipped') outcome = 'skipped';
    else if (/timeout|timed out/i.test((last.statusDetails && last.statusDetails.message) || '')) outcome = 'timedOut';
    else if (last.status === 'failed' || last.status === 'broken') outcome = 'failed';
    else outcome = 'notRun';
    const failing = [...g.attempts].reverse().find((a) => a.status === 'failed' || a.status === 'broken');
    tests.push({
      key: g.key,
      file: g.file,
      title: g.title,
      titlePath: g.titlePath,
      project: null,
      tags: (last.labels || []).filter((l) => l.name === 'tag').map((l) => `@${l.value}`),
      outcome,
      retries: g.attempts.length - 1,
      durationMs: g.attempts.reduce((s, a) => s + Math.max(0, (a.stop || 0) - (a.start || 0)), 0),
      attempts: g.attempts.map((a, i) => ({ retry: i, status: a.status, durationMs: Math.max(0, (a.stop || 0) - (a.start || 0)) })),
      error: failing && failing.statusDetails ? errorSummary({ message: failing.statusDetails.message }) : null,
    });
  }
  const starts = files.map((f) => f.start).filter(Boolean);
  const stops = files.map((f) => f.stop).filter(Boolean);
  return {
    available: tests.length > 0,
    reason: tests.length ? undefined : 'allure-results contained no test results',
    source: 'allure-results',
    fidelity: 'partial',
    fidelityNote: 'Recovered from raw Allure results: retry attempts are grouped by title; per-attempt retry indexes are approximate.',
    startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    durationMs: starts.length && stops.length ? Math.max(...stops) - Math.min(...starts) : null,
    counts: countOutcomes(tests),
    globalErrors: [],
    tests,
  };
}

/** Wraps results with the CI context that produced them (written inside the test job). */
function buildRunResultsFile({ results, env = process.env, missingReason }) {
  return {
    format: RESULTS_FORMAT,
    generatedAt: new Date().toISOString(),
    github: {
      runId: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : null,
      runAttempt: env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : null,
      sha: env.GITHUB_SHA || null,
      ref: env.GITHUB_REF || null,
      event: env.GITHUB_EVENT_NAME || null,
      workflow: env.GITHUB_WORKFLOW || null,
      job: env.GITHUB_JOB || null,
      schedule: env.QA_INTEL_SCHEDULE || null,
      testsStepOutcome: env.QA_INTEL_TESTS_OUTCOME || null,
    },
    results: results || { available: false, reason: missingReason || 'no results', counts: null, tests: [] },
  };
}

module.exports = { RESULTS_FORMAT, fromPlaywrightJson, fromAllureResults, buildRunResultsFile, countOutcomes, emptyCounts };

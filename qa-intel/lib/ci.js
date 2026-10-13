'use strict';

/**
 * Classifies GitHub Actions runs. The rules keep three things apart that are
 * easy to confuse: the pipeline failing before tests ran (setup/install), the
 * tests themselves failing, and reporting/upload failing after tests finished.
 * Missing test results are never read as "0 failures".
 */

const { sanitizeText } = require('./util');

const STAGES = {
  setup: 'Job setup',
  'dependency-install': 'Dependency installation',
  'browser-install': 'Browser installation',
  tests: 'Test execution',
  reporting: 'Report generation / upload',
  history: 'QA history collection',
  teardown: 'Job cleanup',
  unknown: 'Unrecognised step',
};

function stageOfStep(name = '') {
  const n = name.toLowerCase();
  if (/^post |^complete job$/.test(n)) return 'teardown';
  if (/^(set up|setup)\b|checkout|^run actions\/|cache/.test(n)) return 'setup';
  if (/qa[ -]?intel|qa history|history collect/.test(n)) return 'history';
  if (/install (project )?dependencies|npm (ci|install)|yarn( install)?$|pnpm install/.test(n)) return 'dependency-install';
  if (/install playwright|playwright install|browsers?/.test(n)) return 'browser-install';
  if (/report|allure|upload|artifact|summar|notify|email|mail/.test(n)) return 'reporting';
  if (/test|playwright/.test(n)) return 'tests';
  return 'unknown';
}

const CATEGORY_LABELS = {
  passed: 'All tests passed',
  'passed-with-flaky': 'Passed, but some tests needed a retry (flaky)',
  'tests-failed': 'Tests failed',
  'tests-step-failed': 'Test step failed without failing tests',
  'tests-step-failed-no-results': 'Test step failed and no test results were captured',
  'setup-failed': 'Pipeline setup failed before tests ran',
  'dependency-install-failed': 'Dependency installation failed before tests ran',
  'browser-install-failed': 'Browser installation failed before tests ran',
  'reporting-failed': 'Report generation or upload failed',
  'history-failed': 'QA history step failed',
  'failed-unknown-stage': 'Workflow failed at an unrecognised step',
  'infrastructure-failure': 'Workflow failed without a failing step (runner or infrastructure problem)',
  'succeeded-results-missing': 'Workflow succeeded, but test results were not captured',
  cancelled: 'Cancelled',
  'timed-out': 'Timed out',
  'workflow-error': 'Workflow could not start (configuration error)',
  skipped: 'Skipped',
  other: 'Other outcome',
};

const failingCount = (counts) => (counts ? (counts.failed || 0) + (counts.timedOut || 0) + (counts.interrupted || 0) : 0);

/**
 * @param run          workflow run (REST payload)
 * @param jobs         jobs of that attempt (REST payload)
 * @param results      normalised results or { available: false, reason }
 * @param jobTimeouts  optional { [jobName]: timeoutMinutes } from the workflow file
 */
function classifyRun({ run, jobs = [], results, jobTimeouts = {} }) {
  const notes = [];
  const steps = [];
  for (const job of jobs) {
    for (const s of job.steps || []) steps.push({ job: job.name, jobId: job.id, number: s.number, name: s.name, conclusion: s.conclusion, status: s.status, stage: stageOfStep(s.name) });
  }
  const firstFailed = steps.find((s) => s.conclusion === 'failure');
  const testSteps = steps.filter((s) => s.stage === 'tests');
  const testsStepRan = testSteps.some((s) => s.conclusion === 'success' || s.conclusion === 'failure');
  const hasResults = Boolean(results && results.available);
  const failing = hasResults ? failingCount(results.counts) : null;

  let category;
  let failureStage = null;
  let failedStep = null;
  const conclusion = run.conclusion;

  const timedOutJob = jobs.find((j) => {
    if (j.conclusion === 'timed_out') return true;
    const limit = jobTimeouts[j.name];
    if (!limit || j.conclusion !== 'cancelled' || !j.started_at || !j.completed_at) return false;
    return (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000 >= limit * 60 - 30;
  });

  if (conclusion === 'timed_out' || timedOutJob) {
    category = 'timed-out';
    const running = steps.find((s) => s.conclusion === 'cancelled' || s.status === 'in_progress');
    if (running) {
      failureStage = running.stage;
      failedStep = running;
    }
    if (timedOutJob && timedOutJob.conclusion !== 'timed_out') notes.push(`Job "${timedOutJob.name}" ran for its full ${jobTimeouts[timedOutJob.name]}-minute limit before being cancelled (inferred timeout).`);
  } else if (conclusion === 'cancelled') {
    category = 'cancelled';
    const running = steps.find((s) => s.conclusion === 'cancelled');
    if (running) {
      failureStage = running.stage;
      failedStep = running;
    }
  } else if (conclusion === 'startup_failure') {
    category = 'workflow-error';
    failureStage = 'setup';
  } else if (conclusion === 'failure') {
    if (!firstFailed) {
      category = 'infrastructure-failure';
    } else {
      failureStage = firstFailed.stage;
      failedStep = firstFailed;
      if (failureStage === 'setup') category = 'setup-failed';
      else if (failureStage === 'dependency-install') category = 'dependency-install-failed';
      else if (failureStage === 'browser-install') category = 'browser-install-failed';
      else if (failureStage === 'tests') category = !hasResults ? 'tests-step-failed-no-results' : failing > 0 ? 'tests-failed' : 'tests-step-failed';
      else if (failureStage === 'reporting') category = hasResults && failing > 0 ? 'tests-failed' : 'reporting-failed';
      else if (failureStage === 'history') category = hasResults && failing > 0 ? 'tests-failed' : 'history-failed';
      else category = hasResults && failing > 0 ? 'tests-failed' : 'failed-unknown-stage';
      if (failureStage === 'reporting' && category === 'tests-failed') notes.push('Report generation or upload also failed.');
    }
  } else if (conclusion === 'success') {
    if (!hasResults) category = 'succeeded-results-missing';
    else if (failing > 0) category = 'tests-failed';
    else if (results.counts.flaky > 0) category = 'passed-with-flaky';
    else if (results.counts.total === 0) {
      category = 'succeeded-results-missing';
      notes.push('The results file contained no tests.');
    } else category = 'passed';
  } else if (conclusion === 'skipped') category = 'skipped';
  else category = 'other';

  const beforeTests = ['setup-failed', 'dependency-install-failed', 'browser-install-failed', 'workflow-error'].includes(category);
  let testsExecuted;
  if (beforeTests) testsExecuted = false;
  else if (hasResults && results.counts.total > 0) testsExecuted = true;
  else if (testSteps.length && !testsStepRan) testsExecuted = false;
  else testsExecuted = 'unknown';

  if (!hasResults) {
    notes.push(beforeTests
      ? 'Tests did not run, so there are no test results. This is not a test failure.'
      : `Test results are not available${results && results.reason ? ` (${results.reason})` : ''}. Pass/fail counts are unknown — not zero.`);
  }
  if (hasResults && results.globalErrors && results.globalErrors.length) notes.push(`${results.globalErrors.length} error(s) outside individual tests (e.g. configuration or worker errors).`);

  return {
    category,
    label: CATEGORY_LABELS[category] || category,
    failureStage,
    failureStageLabel: failureStage ? STAGES[failureStage] : null,
    failedStep: failedStep ? { job: failedStep.job, number: failedStep.number, name: failedStep.name, conclusion: failedStep.conclusion } : null,
    testsExecuted,
    notes,
  };
}

function durationSeconds(run, jobs) {
  const start = Date.parse(run.run_started_at || run.created_at);
  const ends = jobs.map((j) => Date.parse(j.completed_at)).filter((x) => !Number.isNaN(x));
  const end = ends.length ? Math.max(...ends) : Date.parse(run.updated_at);
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, Math.round((end - start) / 1000));
}

const REPORT_ARTIFACTS = [
  ['playwrightReport', /^playwright-report/i, 'Playwright HTML report'],
  ['allureReport', /^allure-report/i, 'Allure report'],
  ['allureResults', /^allure-results/i, 'Allure raw results'],
  ['qaIntelResults', /^qa-intel-results/i, 'QA Intelligence results'],
];

function reportLinks(repo, run, artifacts, now = new Date()) {
  const out = { runUrl: run.html_url || `https://github.com/${repo}/actions/runs/${run.id}`, artifacts: [] };
  for (const a of artifacts) {
    const entry = {
      name: a.name,
      id: a.id,
      sizeBytes: a.size_in_bytes,
      expiresAt: a.expires_at,
      expired: Boolean(a.expired) || (a.expires_at ? Date.parse(a.expires_at) < now.getTime() : false),
      url: `https://github.com/${repo}/actions/runs/${run.id}/artifacts/${a.id}`,
    };
    out.artifacts.push(entry);
    for (const [key, re, label] of REPORT_ARTIFACTS) if (re.test(a.name) && !out[key]) out[key] = { ...entry, label };
  }
  return out;
}

/** Builds the stored ci.run payload for one completed run attempt. */
function buildRunRecord({ repo, run, jobs, artifacts, results, resultsMeta = {}, jobTimeouts, now }) {
  const classification = classifyRun({ run, jobs, results, jobTimeouts });
  const head = run.head_commit || {};
  return {
    runId: run.id,
    attempt: run.run_attempt || 1,
    runNumber: run.run_number,
    workflow: { id: run.workflow_id, name: run.name, path: run.path },
    event: run.event,
    isScheduled: run.event === 'schedule',
    scheduleCron: resultsMeta.schedule || null,
    branch: run.head_branch,
    sha: run.head_sha,
    title: sanitizeText(run.display_title || head.message || '', 160),
    actor: run.actor ? run.actor.login : null,
    triggeringActor: run.triggering_actor ? run.triggering_actor.login : null,
    commitAuthor: head.author ? head.author.name : null,
    pullRequests: (run.pull_requests || []).map((p) => ({ number: p.number, url: `https://github.com/${repo}/pull/${p.number}`, headBranch: p.head && p.head.ref, baseBranch: p.base && p.base.ref })),
    createdAt: run.created_at,
    startedAt: run.run_started_at || run.created_at,
    completedAt: jobs.map((j) => j.completed_at).filter(Boolean).sort().pop() || run.updated_at,
    durationSec: durationSeconds(run, jobs),
    status: run.status,
    conclusion: run.conclusion,
    classification,
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      url: j.html_url,
      steps: (j.steps || []).map((s) => ({ number: s.number, name: s.name, conclusion: s.conclusion, stage: stageOfStep(s.name) })),
    })),
    tests: results && results.available
      ? { available: true, source: results.source, fidelity: results.fidelity, fidelityNote: results.fidelityNote, counts: results.counts, playwrightStats: results.playwrightStats, globalErrors: results.globalErrors, results: results.tests }
      : { available: false, reason: (results && results.reason) || 'unknown', counts: null, results: [] },
    reports: reportLinks(repo, run, artifacts, now),
  };
}

module.exports = { classifyRun, buildRunRecord, stageOfStep, STAGES, CATEGORY_LABELS, failingCount, reportLinks };

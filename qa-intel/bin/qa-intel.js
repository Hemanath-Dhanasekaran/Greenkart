#!/usr/bin/env node
'use strict';

/**
 * QA CI/CD Intelligence Agent — command line.
 *
 *   qa-intel collect          record new commits and workflow runs into the history
 *   qa-intel ask "<question>" answer a question from the recorded history
 *   qa-intel dashboard        build the self-contained HTML dashboard
 *   qa-intel extract-results  (CI) turn Playwright's JSON report into a sanitised results file
 *   qa-intel index            rebuild the index from the event history
 *   qa-intel verify           integrity checks on the history
 *   qa-intel summary          markdown overview (used for the GitHub job summary)
 *
 * Run `qa-intel help` for options.
 */

const fs = require('fs');
const path = require('path');
const { stableStringify, containsSecret } = require('../lib/util');
const { createGit, repoSlugFromUrl } = require('../lib/git');
const { fromPlaywrightJson, buildRunResultsFile } = require('../lib/results');

// Loaded on first use: `extract-results` runs in the test job even when
// `npm ci` failed, so it must not depend on acorn / yaml / exceljs.
const lazy = (load) => (...args) => load()(...args);
const FileStore = function (...a) { return new (require('../lib/store').FileStore)(...a); };
const GitBranchStore = function (...a) { return new (require('../lib/store').GitBranchStore)(...a); };
const buildIndex = lazy(() => require('../lib/indexer').buildIndex);
const collect = lazy(() => require('../lib/collector').collect);
const testDirFromConfig = lazy(() => require('../lib/collector').testDirFromConfig);
const createGitHubClient = lazy(() => require('../lib/github').createGitHubClient);
const ask = lazy(() => require('../lib/query').ask);
const renderText = lazy(() => require('../lib/query').renderText);
const buildDashboardHtml = lazy(() => require('../lib/dashboard').buildDashboardHtml);

const HELP = `QA CI/CD Intelligence Agent

Usage: node qa-intel/bin/qa-intel.js <command> [options]

Commands
  collect             Record new commits and completed workflow runs.
  ask "<question>"    Answer a question in plain English (dates in IST).
  dashboard           Build the self-contained dashboard HTML.
  extract-results     (CI) Write qa-intel-output/run-results.json from Playwright JSON.
  index               Rebuild index/index.json from the event history.
  verify              Check the history for invalid, duplicate or sensitive records.
  summary             Print a markdown overview (for GitHub job summaries).

Where the history lives (all commands)
  --branch <name>     Git data branch (default: qa-history), via a worktree in .qa-history/
  --store-dir <dir>   Use a plain directory instead of the git data branch
  --offline           Do not fetch the data branch from the remote before reading

collect
  --api               Read workflow runs from the GitHub API (automatic when GITHUB_TOKEN is set)
  --repo <owner/name> Repository (default: GITHUB_REPOSITORY or the origin remote)
  --ref <ref>         Branch to scan for commits (default: origin/main, else HEAD)
  --branch-label <n>  Branch name recorded for those commits (default: derived from --ref)
  --trigger-run-id N  Record this run first (set by the workflow_run trigger)
  --max-runs N        Max run attempts per collection (default 60)
  --max-commits N     Only analyse the newest N commits (older ones become a baseline)
  --no-pr-lookup      Skip pull-request lookups for commits
  --skip-runs | --skip-commits
  --no-push           Commit to the data branch locally but do not push

ask
  --json              Print the structured answer
  --now <ISO time>    Anchor relative dates ("yesterday") to this time

dashboard
  --out <file>        Output file (default: qa-intel-output/qa-dashboard.html)
`;

// Flags that never take a value, so `--offline "question"` keeps the question.
const BOOLEAN_FLAGS = new Set(['offline', 'json', 'api', 'noPush', 'noPrLookup', 'skipRuns', 'skipCommits', 'all', 'open']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) args[key] = inline;
      else if (!BOOLEAN_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

const log = (...m) => console.error('[qa-intel]', ...m);
const repoDir = process.cwd();

function resolveRepo(args) {
  return args.repo || process.env.GITHUB_REPOSITORY || repoSlugFromUrl(createGit(repoDir).remoteUrl('origin'));
}

/** Opens the history for reading: a plain directory or the (fetched) data branch. */
function openForRead(args) {
  if (args.storeDir) return new FileStore(args.storeDir);
  const gbs = new GitBranchStore({ repoDir, branch: typeof args.branch === 'string' ? args.branch : 'qa-history', log });
  const prepared = (() => {
    try {
      return gbs.prepare({ offline: Boolean(args.offline) });
    } catch (err) {
      log(`Could not open the data branch: ${err.message}`);
      return null;
    }
  })();
  if (prepared && prepared.created) log(`The data branch "${gbs.branch}" does not exist yet — run "collect" first (history is empty).`);
  return gbs.store;
}

function loadIndex(store, { rebuild = false } = {}) {
  const existing = !rebuild && store.readJson('index/index.json');
  if (existing && existing.format === 'qa-intel-index') return existing;
  const { events, stats } = store.loadEvents();
  return buildIndex(events, { storeStats: stats });
}

function writeDerived(store, repo) {
  const { events, stats } = store.loadEvents();
  const index = buildIndex(events, { repo, storeStats: stats });
  store.writeJson('index/index.json', index);
  store.writeJson('dashboard/index.html', buildDashboardHtml(index));
  return index;
}

function summaryMarkdown(index) {
  const lines = ['## QA Intelligence', ''];
  const latest = index.runs[0];
  const t = index.totals;
  lines.push(`History: **${t.commits}** commits, **${t.activeTests}** active tests, **${t.runs}** CI runs recorded (${t.runsWithResults} with test results).`, '');
  if (latest) {
    const a = ask(index, 'what happened in the latest run');
    lines.push(`**Latest run:** ${a.headline}`, '');
  }
  for (const q of ['summarize this week', 'which changed methods have not been covered by a successful relevant test run']) {
    lines.push(`**${q[0].toUpperCase()}${q.slice(1)}:** ${ask(index, q).headline}`, '');
  }
  const ins = index.insights;
  lines.push(`Risks: ${ins.newFailures.length} pass→fail transitions, ${ins.repeatedFailures.length} repeated failures, ${ins.flaky.length} flaky, ${ins.consistentlySkipped.length} consistently skipped, ${ins.pipelineFailures.length} pipeline failures.`);
  if (index.dataQuality.length) lines.push('', ...index.dataQuality.map((d) => `> ⚠️ ${d.text}`));
  lines.push('', '_Download the `qa-dashboard` artifact for the full dashboard, or run `npm run qa:ask -- "<question>"` locally._');
  return lines.join('\n');
}

async function cmdCollect(args) {
  const repo = resolveRepo(args);
  if (!repo) throw new Error('Cannot determine the GitHub repository; pass --repo owner/name');
  const git = createGit(repoDir);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  const useApi = Boolean(token || args.api);
  const github = useApi ? createGitHubClient({ token, repo, log }) : null;
  if (!useApi) log('GitHub API disabled (no GITHUB_TOKEN and no --api): only git history will be collected.');
  else if (!token) log('No GITHUB_TOKEN: using the unauthenticated API (60 requests/hour); test-result artifacts cannot be downloaded.');

  let ref = args.ref;
  if (!ref) ref = git.resolve('refs/remotes/origin/main') ? 'origin/main' : 'HEAD';
  const branchLabel = args.branchLabel || (ref.replace(/^(refs\/remotes\/)?origin\//, '').replace(/^refs\/heads\//, '') === 'HEAD' ? git.currentBranch() || 'HEAD' : ref.replace(/^(refs\/remotes\/)?origin\//, '').replace(/^refs\/heads\//, ''));

  const options = {
    repoDir,
    repo,
    github,
    refs: [{ ref, branch: branchLabel }],
    maxCommits: args.maxCommits ? Number(args.maxCommits) : undefined,
    maxRuns: args.maxRuns ? Number(args.maxRuns) : 60,
    maxRunPages: args.maxRunPages ? Number(args.maxRunPages) : 3,
    triggerRunId: args.triggerRunId || process.env.QA_INTEL_TRIGGER_RUN_ID || undefined,
    excludeWorkflowPaths: ['qa-intel.yml', 'qa-intel-selftest.yml'],
    includeWorkflows: args.workflows ? String(args.workflows).split(',').map((s) => s.trim()) : undefined,
    prLookup: !args.noPrLookup,
    skipRuns: Boolean(args.skipRuns),
    skipCommits: Boolean(args.skipCommits),
    testDir: testDirFromConfig(repoDir),
    log,
  };

  const runCollection = async (store) => {
    store.ensureLayout(repo);
    const { events: existing } = store.loadEvents();
    const result = await collect({ ...options, existingEvents: existing });
    return result;
  };

  let outcome;
  if (args.storeDir) {
    const store = new FileStore(args.storeDir);
    store.cleanTemp();
    const result = await runCollection(store);
    const appended = store.append(result.events, { label: process.env.GITHUB_RUN_ID ? `run-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : 'local' });
    const index = writeDerived(store, repo);
    outcome = { result, appended, index };
  } else {
    const gbs = new GitBranchStore({ repoDir, branch: typeof args.branch === 'string' ? args.branch : 'qa-history', log });
    gbs.prepare();
    const result = await runCollection(gbs.store);
    let appended;
    let index;
    const update = await gbs.update(async (store) => {
      store.ensureLayout(repo);
      appended = store.append(result.events, { label: process.env.GITHUB_RUN_ID ? `run-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : 'local' });
      // Nothing new → keep the existing index, so no empty commit is pushed.
      index = appended.written || !store.readJson('index/index.json') ? writeDerived(store, repo) : loadIndex(store);
      return {};
    }, { message: `QA history: ${result.commits} commit(s), ${result.runs} run attempt(s)`, push: !args.noPush });
    outcome = { result, appended, index, update };
  }

  const { result, appended, index, update } = outcome;
  log(`Collected ${result.commits} new commit(s) and ${result.runs} run attempt(s); stored ${appended.written} new event(s), skipped ${appended.skipped} already-known.`);
  if (appended.droppedForSecrets) log(`⚠️ Dropped ${appended.droppedForSecrets} event(s) that still looked like they contained secrets after redaction.`);
  if (update) log(update.pushed ? `Pushed history to "${typeof args.branch === 'string' ? args.branch : 'qa-history'}" (attempt ${update.attempts}).` : update.committed ? 'Committed history locally (not pushed).' : 'History unchanged.');
  result.warnings.forEach((w) => log(`warning: ${w}`));
  if (github) log(`GitHub API: ${github.stats.requests} request(s), ${github.stats.retries} retr${github.stats.retries === 1 ? 'y' : 'ies'}, rate limit remaining ${github.stats.rateLimitRemaining ?? 'n/a'}.`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryMarkdown(index)}\n`);
  if (args.dashboardOut) writeFile(args.dashboardOut, buildDashboardHtml(index));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
  log(`Wrote ${file}`);
}

function cmdExtractResults(args) {
  const input = args.input || 'qa-intel-output/playwright-results.json';
  const output = args.output || 'qa-intel-output/run-results.json';
  let file;
  try {
    if (!fs.existsSync(input)) {
      file = buildRunResultsFile({ missingReason: `Playwright JSON report not found at ${input} — the test step did not produce results (it may not have started, crashed, or been cancelled)` });
    } else {
      const json = JSON.parse(fs.readFileSync(input, 'utf8'));
      file = buildRunResultsFile({ results: fromPlaywrightJson(json, repoDir) });
    }
  } catch (err) {
    file = buildRunResultsFile({ missingReason: `Playwright JSON report could not be read: ${err.message}` });
  }
  if (containsSecret(JSON.stringify(file))) log('⚠️ results still contain secret-like text after redaction');
  writeFile(output, `${JSON.stringify(file, null, 2)}\n`);
  const r = file.results;
  log(r.available ? `Results: ${r.counts.total} tests — ${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.timedOut} timed out, ${r.counts.flaky} flaky, ${r.counts.skipped} skipped.` : `No results: ${r.reason}`);
}

async function cmdAsk(args) {
  const question = args._.slice(1).join(' ').trim();
  if (!question) throw new Error('Usage: qa-intel ask "What tests were added this week?"');
  const index = args.index ? JSON.parse(fs.readFileSync(args.index, 'utf8')) : loadIndex(openForRead(args));
  const answer = ask(index, question, { now: args.now });
  console.log(args.json ? JSON.stringify(answer, null, 2) : renderText(answer, { maxItems: args.all ? 1000 : 15 }));
}

function cmdDashboard(args) {
  const index = args.index ? JSON.parse(fs.readFileSync(args.index, 'utf8')) : loadIndex(openForRead(args));
  const out = args.out || 'qa-intel-output/qa-dashboard.html';
  writeFile(out, buildDashboardHtml(index));
  if (args.open) {
    const { spawn } = require('child_process');
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', path.resolve(out)]] : process.platform === 'darwin' ? ['open', [out]] : ['xdg-open', [out]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  }
}

function cmdIndex(args) {
  const store = openForRead(args);
  const index = writeDerived(store, resolveRepo(args));
  log(`Rebuilt index from ${index.eventCount} event(s) in ${store.dir}.`);
}

function cmdVerify(args) {
  const store = openForRead(args);
  const { events, stats } = store.loadEvents();
  const problems = [...stats.problems];
  for (const e of events) if (containsSecret(JSON.stringify(e))) problems.push(`${e.id} contains secret-like text`);
  const strip = (i) => stableStringify({ ...i, builtAt: null });
  const a = buildIndex(events, { now: new Date(0) });
  const b = buildIndex([...events].reverse(), { now: new Date(0) });
  if (strip(a) !== strip(b)) problems.push('index is not deterministic for the same events');
  console.log(`Events: ${events.length} unique (${stats.lines} lines in ${stats.files} file(s), ${stats.duplicates} duplicate line(s) collapsed, ${stats.invalid} invalid).`);
  console.log(`Commits: ${a.totals.commits} · tests: ${a.totals.activeTests} active / ${a.totals.deletedTests} deleted · runs: ${a.totals.runs} (${a.totals.runsWithResults} with results).`);
  if (problems.length) {
    problems.forEach((p) => console.log(`✗ ${p}`));
    process.exitCode = 1;
  } else console.log('✓ History is valid.');
}

function cmdSummary(args) {
  console.log(summaryMarkdown(loadIndex(openForRead(args))));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'collect': return cmdCollect(args);
    case 'extract-results': return cmdExtractResults(args);
    case 'ask': return cmdAsk(args);
    case 'dashboard': return cmdDashboard(args);
    case 'index': return cmdIndex(args);
    case 'verify': return cmdVerify(args);
    case 'summary': return cmdSummary(args);
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
}

main().catch((err) => {
  log(`error: ${err.message}`);
  process.exitCode = 1;
});

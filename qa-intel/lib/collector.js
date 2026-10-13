'use strict';

/**
 * Turns git history and GitHub Actions runs into history events.
 * Only work that is not already in the store is done, so the collector can be
 * run any number of times (retries, overlapping triggers, recovery sweeps).
 */

const path = require('path');
const YAML = require('yaml');
const { createGit } = require('./git');
const { buildSnapshot } = require('./snapshot');
const { diffCommit } = require('./changes');
const { makeEvent } = require('./store');
const { buildRunRecord } = require('./ci');
const { fromAllureResults, RESULTS_FORMAT } = require('./results');
const { unzip } = require('./github');
const { sanitizeText } = require('./util');

const RANK = { retryableMissing: 1, finalMissing: 2, results: 3 };

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function knownState(events) {
  const commits = new Set();
  const runs = new Map();
  for (const e of events) {
    if (e.type === 'commit.recorded') commits.add(e.data.sha);
    if (e.type === 'snapshot.baseline') commits.add(e.data.sha);
    if (e.type === 'ci.run') runs.set(`${e.data.runId}|${e.data.attempt}`, e.rank || 0);
  }
  return { commits, runs };
}

/** LRU of analysed snapshots: consecutive commits share most of their files. */
function snapshotCache(git) {
  const analyses = new Map();
  const snaps = new Map();
  return (sha) => {
    const key = sha || 'EMPTY';
    if (snaps.has(key)) return snaps.get(key);
    const snap = buildSnapshot(git, sha, analyses);
    snaps.set(key, snap);
    if (snaps.size > 4) snaps.delete(snaps.keys().next().value);
    return snap;
  };
}

async function collectCommits({ git, repo, github, known, refs, maxCommits, prLookup = true, log }) {
  const events = [];
  const warnings = [];
  if (git.isShallow()) warnings.push('The repository clone is shallow; commits before the shallow boundary are not analysed. Use fetch-depth: 0.');
  const snapshotOf = snapshotCache(git);
  const queued = new Set();
  const plan = [];
  for (const { ref, branch } of refs) {
    const head = git.resolve(ref);
    if (!head) {
      warnings.push(`Ref ${ref} not found; skipped.`);
      continue;
    }
    for (const sha of git.revList(head, { max: maxCommits })) {
      if (known.commits.has(sha) || queued.has(sha)) continue;
      queued.add(sha);
      plan.push({ sha, branch, ref: head });
    }
  }
  if (!plan.length) return { events, warnings, processed: 0 };
  log(`Analysing ${plan.length} new commit(s)…`);

  // Commit author logins in bulk (one request per 100 commits).
  const logins = new Map();
  if (github) {
    for (const head of new Set(plan.map((p) => p.ref))) {
      try {
        const commits = await github.listCommits(head, Math.min(10, Math.ceil(plan.length / 100) + 1));
        for (const c of commits) if (c.author && c.author.login) logins.set(c.sha, c.author.login);
      } catch (err) {
        warnings.push(`Could not read commit authors from GitHub: ${err.message}`);
        break;
      }
    }
  }

  let prBudgetExhausted = false;
  for (const { sha, branch } of plan) {
    const meta = git.commitMeta(sha);
    let parent = meta.parents[0] || null;
    if (parent && !git.hasObject(parent)) {
      warnings.push(`Parent of ${sha.slice(0, 7)} is missing (shallow clone); treating ${sha.slice(0, 7)} as a baseline.`);
      parent = null;
    }
    // History collected from the middle of the repository: record what already existed.
    if (parent && !known.commits.has(parent) && !queued.has(parent)) {
      const base = snapshotOf(parent);
      const baseMeta = git.commitMeta(parent);
      events.push(makeEvent({
        type: 'snapshot.baseline',
        naturalKey: parent,
        occurredAt: new Date(baseMeta.committedAt).toISOString(),
        repo,
        source: 'git',
        data: {
          sha: parent,
          committedAt: baseMeta.committedAt,
          note: 'History collection started after this commit; these tests and symbols already existed.',
          tests: [...base.tests.values()].map((t) => ({ key: t.key, title: t.title, titlePath: t.titlePath, file: t.file, line: t.line, tags: t.tags })),
          symbols: [...base.symbols.values()].map((s) => ({ id: s.id, kind: s.kind, qualifiedName: s.qualifiedName, file: s.file, category: s.category })),
        },
      }));
      known.commits.add(parent);
    }

    const parentSnap = snapshotOf(parent);
    const childSnap = snapshotOf(sha);
    const nameStatus = git.nameStatus(sha, parent);
    const diff = await diffCommit({ git, nameStatus, parentSnap, childSnap });

    let pullRequests = null;
    if (github && prLookup && !prBudgetExhausted) {
      if (github.stats.rateLimitRemaining !== null && github.stats.rateLimitRemaining < 15) {
        prBudgetExhausted = true;
        warnings.push('Skipped pull-request lookups for some commits to preserve the GitHub API rate limit.');
      } else {
        try {
          pullRequests = (await github.commitPulls(sha)).map((p) => ({ number: p.number, title: sanitizeText(p.title, 120), url: p.html_url, state: p.state, merged: Boolean(p.merged_at) }));
        } catch (err) {
          if (err.rateLimited) prBudgetExhausted = true;
          warnings.push(`Pull-request lookup failed for ${sha.slice(0, 7)}: ${err.message}`);
        }
      }
    }

    const occurredAt = new Date(meta.committedAt).toISOString();
    const commitUrl = `https://github.com/${repo}/commit/${sha}`;
    const common = {
      sha,
      shortSha: sha.slice(0, 7),
      branch,
      author: meta.authorName,
      authorLogin: logins.get(sha) || null,
      committedAt: meta.committedAt,
      pullRequests,
    };
    const fileUrl = (file, line) => `https://github.com/${repo}/blob/${sha}/${encodePath(file)}${line ? `#L${line}` : ''}`;
    const parentFileUrl = (file, line) => (parent ? `https://github.com/${repo}/blob/${parent}/${encodePath(file)}${line ? `#L${line}` : ''}` : null);

    events.push(makeEvent({
      type: 'commit.recorded',
      naturalKey: sha,
      occurredAt,
      repo,
      source: 'git',
      data: {
        ...common,
        parents: meta.parents,
        authoredAt: meta.authoredAt,
        subject: sanitizeText(meta.subject, 200),
        files: diff.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, category: f.category, note: f.note })),
        counts: {
          files: diff.files.length,
          testChanges: diff.testChanges.length,
          testsAdded: diff.testChanges.filter((t) => t.type === 'added').length,
          testsDeleted: diff.testChanges.filter((t) => t.type === 'deleted').length,
          codeChanges: diff.symbolChanges.length,
          configChanges: diff.configChanges.length,
        },
        links: { commit: commitUrl },
      },
    }));

    for (const t of diff.testChanges) {
      events.push(makeEvent({
        type: `test.${t.type}`,
        naturalKey: `${sha}|${t.type}|${t.test.key}|${t.previous ? t.previous.key : ''}`,
        occurredAt,
        repo,
        source: 'git',
        data: {
          ...common,
          ...t,
          links: {
            commit: commitUrl,
            file: t.type === 'deleted' ? parentFileUrl(t.test.file, t.test.line) : fileUrl(t.test.file, t.test.line),
            previousFile: t.previous ? parentFileUrl(t.previous.file, t.previous.line) : undefined,
          },
        },
      }));
    }
    for (const s of diff.symbolChanges) {
      events.push(makeEvent({
        type: `code.${s.type}`,
        naturalKey: `${sha}|${s.type}|${s.symbol.id}|${s.previous ? s.previous.id : ''}`,
        occurredAt,
        repo,
        source: 'git',
        data: {
          ...common,
          ...s,
          links: { commit: commitUrl, file: s.type === 'deleted' ? parentFileUrl(s.symbol.file, s.symbol.line) : fileUrl(s.symbol.file, s.symbol.line) },
        },
      }));
    }
    for (const c of diff.configChanges) {
      events.push(makeEvent({
        type: 'config.changed',
        naturalKey: `${sha}|${c.file}`,
        occurredAt,
        repo,
        source: 'git',
        data: { ...common, ...c, links: { commit: commitUrl, file: c.status === 'deleted' ? parentFileUrl(c.file) : fileUrl(c.file) } },
      }));
    }
    known.commits.add(sha);
  }
  return { events, warnings, processed: plan.length };
}

function jobTimeoutsAt(git, sha, workflowPath) {
  if (!sha || !workflowPath || !git.hasObject(sha)) return {};
  const content = git.tryRun(['show', `${sha}:${workflowPath}`]);
  if (!content) return {};
  try {
    const doc = YAML.parse(content) || {};
    const out = {};
    for (const [id, job] of Object.entries(doc.jobs || {})) if (job && job['timeout-minutes']) out[job.name || id] = job['timeout-minutes'];
    return out;
  } catch {
    return {};
  }
}

async function fetchRunResults({ github, run, attempt, artifacts, testDir }) {
  if (!github.hasToken) return { results: { available: false, reason: 'downloading workflow artifacts needs a GitHub token — results are collected in CI' }, rank: RANK.retryableMissing };
  const live = artifacts.filter((a) => !a.expired);
  const qa = artifacts.filter((a) => /^qa-intel-results/.test(a.name));
  const exact = qa.find((a) => a.name === `qa-intel-results-attempt-${attempt}`) || (attempt === 1 ? qa.find((a) => a.name === 'qa-intel-results') : null);
  try {
    if (exact && !exact.expired) {
      const files = unzip(await github.downloadArtifact(exact.id));
      const file = files.find((f) => /run-results\.json$/.test(f.name));
      if (!file) return { results: { available: false, reason: 'qa-intel-results artifact had no run-results.json' }, rank: RANK.finalMissing };
      const parsed = JSON.parse(file.data.toString('utf8'));
      if (parsed.format !== RESULTS_FORMAT) return { results: { available: false, reason: `unsupported results format ${parsed.format}` }, rank: RANK.finalMissing };
      if (parsed.github && parsed.github.runId && Number(parsed.github.runId) !== Number(run.id)) return { results: { available: false, reason: 'results file belongs to a different run' }, rank: RANK.finalMissing };
      return { results: parsed.results, meta: parsed.github || {}, rank: parsed.results && parsed.results.available ? RANK.results : RANK.finalMissing };
    }
    const allure = live.find((a) => a.name === 'allure-results');
    const allureUsable = allure && (attempt === (run.run_attempt || 1));
    if (allureUsable) {
      const files = unzip(await github.downloadArtifact(allure.id))
        .filter((f) => /-result\.json$/.test(f.name))
        .map((f) => {
          try {
            return JSON.parse(f.data.toString('utf8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const results = fromAllureResults(files, testDir);
      return { results, rank: results.available ? RANK.results : RANK.finalMissing };
    }
  } catch (err) {
    return { results: { available: false, reason: `could not download results artifact: ${sanitizeText(err.message, 160)}` }, rank: RANK.retryableMissing };
  }
  if (exact && exact.expired) return { results: { available: false, reason: 'the results artifact has expired (GitHub deletes artifacts after their retention period)' }, rank: RANK.finalMissing };
  if (artifacts.some((a) => a.expired)) return { results: { available: false, reason: 'the run\'s artifacts have expired' }, rank: RANK.finalMissing };
  return { results: { available: false, reason: artifacts.length ? 'the run uploaded no test-results artifact' : 'the run produced no artifacts (it may have stopped before tests ran)' }, rank: RANK.finalMissing };
}

async function collectRuns({ git, repo, github, known, maxPages = 2, maxRuns = 60, triggerRunId, excludeWorkflowPaths = [], includeWorkflows, testDir = 'tests', log, now = new Date() }) {
  const events = [];
  const warnings = [];
  let runs;
  try {
    runs = await github.listRuns({ maxPages });
  } catch (err) {
    return { events, warnings: [`Could not list workflow runs: ${err.message}`], processed: 0 };
  }
  if (triggerRunId && !runs.find((r) => String(r.id) === String(triggerRunId))) {
    try {
      runs.unshift(await github.getRun(triggerRunId));
    } catch (err) {
      warnings.push(`Could not read triggering run ${triggerRunId}: ${err.message}`);
    }
  }
  const relevant = runs
    .filter((r) => r.status === 'completed')
    .filter((r) => !excludeWorkflowPaths.some((p) => (r.path || '').endsWith(p)))
    .filter((r) => !includeWorkflows || includeWorkflows.includes(r.name))
    .sort((a, b) => (String(a.id) === String(triggerRunId) ? -1 : String(b.id) === String(triggerRunId) ? 1 : Date.parse(b.created_at) - Date.parse(a.created_at)));

  const todo = [];
  for (const run of relevant) {
    const latest = run.run_attempt || 1;
    for (let attempt = latest; attempt >= 1; attempt--) {
      const rank = known.runs.get(`${run.id}|${attempt}`);
      if (rank !== undefined && rank >= RANK.finalMissing) continue;
      if (rank !== undefined && !github.hasToken) continue; // nothing better available without a token
      todo.push({ run, attempt });
    }
  }
  const selected = todo.slice(0, maxRuns);
  if (todo.length > selected.length) warnings.push(`${todo.length - selected.length} older run(s) left for the next collection (limit ${maxRuns} per collection).`);
  if (selected.length) log(`Recording ${selected.length} workflow run attempt(s)…`);

  const artifactCache = new Map();
  for (const { run: listed, attempt } of selected) {
    try {
      const run = attempt === (listed.run_attempt || 1) ? listed : await github.getRunAttempt(listed.id, attempt);
      if (run.status !== 'completed') continue;
      const jobs = await github.listJobs(listed.id, attempt);
      if (!artifactCache.has(listed.id)) artifactCache.set(listed.id, await github.listArtifacts(listed.id));
      const artifacts = artifactCache.get(listed.id);
      const { results, meta = {}, rank } = await fetchRunResults({ github, run, attempt, artifacts, testDir });
      const record = buildRunRecord({ repo, run, jobs, artifacts, results, resultsMeta: meta, jobTimeouts: jobTimeoutsAt(git, run.head_sha, run.path), now });
      events.push(makeEvent({ type: 'ci.run', naturalKey: `${listed.id}|${attempt}`, occurredAt: new Date(record.completedAt || run.updated_at).toISOString(), repo, source: 'github-actions', rank, data: record }));
      known.runs.set(`${listed.id}|${attempt}`, rank);
    } catch (err) {
      warnings.push(`Run ${listed.id} attempt ${attempt} not recorded this time: ${err.message}`);
      if (err.rateLimited) break;
    }
  }
  return { events, warnings, processed: events.length };
}

/** Commits that CI ran against but which are not on the scanned branches (e.g. PR heads). */
function extraRunRefs(git, runEvents, known) {
  const refs = [];
  for (const e of runEvents) {
    const { sha, branch, pullRequests } = e.data;
    if (!sha || known.commits.has(sha)) continue;
    if (!git.hasObject(sha)) git.tryRun(['fetch', '--no-tags', 'origin', sha]);
    if (!git.hasObject(sha) && pullRequests && pullRequests[0]) git.tryRun(['fetch', '--no-tags', 'origin', `pull/${pullRequests[0].number}/head`]);
    if (git.hasObject(sha)) refs.push({ ref: sha, branch: branch || 'unknown' });
  }
  return refs;
}

async function collect({ repoDir, repo, github, existingEvents, refs, maxCommits, maxRuns, maxRunPages, triggerRunId, excludeWorkflowPaths, includeWorkflows, prLookup, skipRuns, skipCommits, testDir, log = () => {} }) {
  const git = createGit(repoDir);
  const known = knownState(existingEvents);
  const out = { events: [], warnings: [], commits: 0, runs: 0 };

  if (github && !skipRuns) {
    const r = await collectRuns({ git, repo, github, known, maxPages: maxRunPages, maxRuns, triggerRunId, excludeWorkflowPaths, includeWorkflows, testDir, log });
    out.events.push(...r.events);
    out.warnings.push(...r.warnings);
    out.runs = r.processed;
  }
  if (!skipCommits) {
    const runRefs = github ? extraRunRefs(git, out.events.filter((e) => e.type === 'ci.run'), known) : [];
    const c = await collectCommits({ git, repo, github, known, refs: [...refs, ...runRefs], maxCommits, prLookup, log });
    out.events.push(...c.events);
    out.warnings.push(...c.warnings);
    out.commits = c.processed;
  }
  return out;
}

module.exports = { collect, collectCommits, collectRuns, fetchRunResults, knownState, RANK, testDirFromConfig };

function testDirFromConfig(repoDir) {
  try {
    const { flattenConfig } = require('./configDiff');
    const fs = require('fs');
    const file = ['playwright.config.js', 'playwright.config.cjs', 'playwright.config.ts'].map((f) => path.join(repoDir, f)).find((f) => fs.existsSync(f));
    const cfg = file ? flattenConfig(fs.readFileSync(file, 'utf8')) : null;
    const raw = cfg && cfg.testDir ? cfg.testDir.replace(/^['"`]|['"`]$/g, '') : 'tests';
    return path.posix.normalize(raw).replace(/^\.\//, '');
  } catch {
    return 'tests';
  }
}

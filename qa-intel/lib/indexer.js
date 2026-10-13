'use strict';

/**
 * Builds the queryable index from the raw event history. The index is pure
 * derived data: deleting it and rebuilding from events gives the same result.
 *
 * Besides flattening events, it computes:
 *  - stable test ids (lineage) that survive renames and moves
 *  - which runs tested a commit that contains each change (commit ancestry)
 *  - coverage status of every change (confirmed by a passing run, or not)
 *  - risk insights: repeated failures, flaky/skipped tests, new failures and
 *    the commits between the last pass and the first failure
 */

const { sha256, SCHEMA_VERSION } = require('./util');
const { istDateKey } = require('./time');
const { CATEGORY_LABELS } = require('./snapshot');

const PASS = new Set(['passed', 'flaky']);
const FAIL = new Set(['failed', 'timedOut', 'interrupted']);
const PIPELINE_FAILURES = new Set(['setup-failed', 'dependency-install-failed', 'browser-install-failed', 'workflow-error', 'infrastructure-failure']);

function topoOrder(commits) {
  const shas = Object.keys(commits);
  const children = new Map(shas.map((s) => [s, []]));
  const indeg = new Map(shas.map((s) => [s, 0]));
  for (const s of shas) {
    for (const p of commits[s].parents || []) {
      if (!commits[p]) continue;
      children.get(p).push(s);
      indeg.set(s, indeg.get(s) + 1);
    }
  }
  const byTime = (a, b) => Date.parse(commits[a].committedAt) - Date.parse(commits[b].committedAt) || (a < b ? -1 : 1);
  const ready = shas.filter((s) => indeg.get(s) === 0).sort(byTime);
  const out = [];
  while (ready.length) {
    const s = ready.shift();
    out.push(s);
    for (const c of children.get(s)) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) {
        ready.push(c);
        ready.sort(byTime);
      }
    }
  }
  return out;
}

const TYPE_ORDER = { 'test.deleted': 0, 'test.renamed': 1, 'test.moved': 1, 'test.modified': 2, 'test.added': 3 };

function buildIndex(allEvents, { now = new Date(), repo, storeStats } = {}) {
  const events = [...allEvents].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.id < b.id ? -1 : 1));
  const repoName = repo || (events[0] && events[0].repo) || null;

  // ── Commits ────────────────────────────────────────────────────────────────
  const commits = {};
  const baselines = [];
  for (const e of events) {
    if (e.type === 'commit.recorded') {
      const d = e.data;
      commits[d.sha] = { ...d, eventId: e.id, url: d.links && d.links.commit };
    } else if (e.type === 'snapshot.baseline') {
      baselines.push(e.data);
      if (!commits[e.data.sha]) commits[e.data.sha] = { sha: e.data.sha, shortSha: e.data.sha.slice(0, 7), parents: [], committedAt: e.data.committedAt, baseline: true, subject: '(history starts after this commit)', files: [], counts: {} };
    }
  }
  const order = topoOrder(commits);
  const position = new Map(order.map((s, i) => [s, i]));

  const ancestorCache = new Map();
  function ancestors(sha) {
    if (ancestorCache.has(sha)) return ancestorCache.get(sha);
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop();
      if (seen.has(s) || !commits[s]) continue;
      seen.add(s);
      for (const p of commits[s].parents || []) stack.push(p);
    }
    ancestorCache.set(sha, seen);
    return seen;
  }

  // ── Test lineage ───────────────────────────────────────────────────────────
  const tests = {};
  const keyToId = {};
  const newTestId = (key, sha) => `T${sha256(`${key}|${sha || 'baseline'}`).slice(0, 10)}`;
  const ensureTest = (key, sha, info, at) => {
    if (keyToId[key] && tests[keyToId[key]]) return tests[keyToId[key]];
    const testId = newTestId(key, sha);
    tests[testId] = { testId, key, keys: [key], title: info.title, titlePath: info.titlePath, file: info.file, line: info.line, tags: info.tags || [], status: 'active', firstSeen: { sha, at }, lastChange: null, changes: [] };
    keyToId[key] = testId;
    return tests[testId];
  };
  for (const b of baselines) for (const t of b.tests) ensureTest(t.key, null, t, b.committedAt).firstSeen.baseline = true;

  const testEventsByCommit = new Map();
  for (const e of events) {
    if (!e.type.startsWith('test.')) continue;
    if (!testEventsByCommit.has(e.data.sha)) testEventsByCommit.set(e.data.sha, []);
    testEventsByCommit.get(e.data.sha).push(e);
  }
  const testChanges = [];
  const orderedShas = [...order, ...[...testEventsByCommit.keys()].filter((s) => !position.has(s))];
  for (const sha of orderedShas) {
    const list = (testEventsByCommit.get(sha) || []).sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    for (const e of list) {
      const d = e.data;
      const type = e.type.slice(5);
      let t;
      if (type === 'added') {
        const existing = keyToId[d.test.key] && tests[keyToId[d.test.key]];
        t = existing && existing.status === 'deleted' ? null : existing;
        if (!t) {
          const testId = newTestId(d.test.key, sha);
          t = { testId, key: d.test.key, keys: [d.test.key], title: d.test.title, titlePath: d.test.titlePath, file: d.test.file, line: d.test.line, tags: d.test.tags, status: 'active', firstSeen: { sha, at: d.committedAt }, lastChange: null, changes: [] };
          tests[testId] = t;
          keyToId[d.test.key] = testId;
        }
      } else if (type === 'renamed' || type === 'moved') {
        t = ensureTest(d.previous.key, null, d.previous, d.committedAt);
        t.key = d.test.key;
        if (!t.keys.includes(d.test.key)) t.keys.push(d.test.key);
        keyToId[d.test.key] = t.testId;
        Object.assign(t, { title: d.test.title, titlePath: d.test.titlePath, file: d.test.file, line: d.test.line, tags: d.test.tags });
      } else {
        t = ensureTest(d.test.key, null, d.test, d.committedAt);
        if (type === 'modified') Object.assign(t, { line: d.test.line, tags: d.test.tags });
        if (type === 'deleted') {
          t.status = 'deleted';
          t.deletedAt = d.committedAt;
          t.deletedSha = sha;
        }
      }
      t.lastChange = { sha, at: d.committedAt, type };
      t.changes.push(e.id);
      testChanges.push({
        id: e.id,
        type,
        at: d.committedAt,
        sha,
        shortSha: sha.slice(0, 7),
        testId: t.testId,
        key: d.test.key,
        title: d.test.title,
        titlePath: d.test.titlePath,
        file: d.test.file,
        previousTitle: d.previous ? d.previous.title : undefined,
        previousFile: d.previous ? d.previous.file : undefined,
        previousKey: d.previous ? d.previous.key : undefined,
        tags: d.test.tags,
        summary: d.summary,
        details: d.details,
        evidence: d.evidence,
        author: d.author,
        authorLogin: d.authorLogin,
        branch: d.branch,
        pullRequests: d.pullRequests,
        links: d.links,
      });
    }
  }

  // ── Framework code and configuration changes ──────────────────────────────
  const codeChanges = [];
  const configChanges = [];
  for (const e of events) {
    const d = e.data;
    if (e.type.startsWith('code.')) {
      const impact = d.impact || { scope: 'none', tests: [] };
      codeChanges.push({
        id: e.id,
        type: e.type.slice(5),
        at: d.committedAt,
        sha: d.sha,
        shortSha: d.shortSha,
        symbolId: d.symbol.id,
        kind: d.symbol.kind,
        name: d.symbol.name,
        qualifiedName: d.symbol.qualifiedName,
        className: d.symbol.className,
        file: d.symbol.file,
        category: d.symbol.category,
        categoryLabel: CATEGORY_LABELS[d.symbol.category] || d.symbol.category,
        previous: d.previous ? { qualifiedName: d.previous.qualifiedName, file: d.previous.file, id: d.previous.id } : undefined,
        summary: d.summary,
        details: d.details,
        evidence: d.evidence,
        impact: { scope: impact.scope, reason: impact.reason, tests: (impact.tests || []).map((t) => ({ ...t, testId: keyToId[t.testKey] || null })), allTestsCount: impact.allTests ? impact.allTests.length : undefined },
        author: d.author,
        authorLogin: d.authorLogin,
        branch: d.branch,
        pullRequests: d.pullRequests,
        links: d.links,
      });
    } else if (e.type === 'config.changed') {
      const impact = d.impact || { scope: 'unknown', tests: [] };
      configChanges.push({
        id: e.id,
        type: 'changed',
        status: d.status,
        at: d.committedAt,
        sha: d.sha,
        shortSha: d.shortSha,
        file: d.file,
        category: d.category,
        categoryLabel: CATEGORY_LABELS[d.category] || d.category,
        summary: d.summary,
        details: d.details,
        impact: { scope: impact.scope, reason: impact.reason, tests: (impact.tests || []).map((t) => ({ ...t, testId: keyToId[t.testKey] || null })), allTestsCount: impact.allTests ? impact.allTests.length : undefined },
        author: d.author,
        authorLogin: d.authorLogin,
        branch: d.branch,
        pullRequests: d.pullRequests,
        links: d.links,
      });
    }
  }

  // ── CI runs ────────────────────────────────────────────────────────────────
  const runs = events.filter((e) => e.type === 'ci.run').map((e) => {
    const d = e.data;
    const results = (d.tests.results || []).map((r) => ({ ...r, testId: keyToId[r.key] || null }));
    return {
      id: e.id,
      runKey: `${d.runId}#${d.attempt}`,
      ...d,
      at: d.completedAt,
      commitKnown: Boolean(commits[d.sha]),
      commitSubject: commits[d.sha] ? commits[d.sha].subject : null,
      tests: { ...d.tests, results },
      link: d.reports && d.reports.runUrl,
    };
  });
  runs.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));

  const runsWithResults = runs.filter((r) => r.tests.available);
  const containing = (sha) => runs.filter((r) => commits[r.sha] && ancestors(r.sha).has(sha));
  const outcomeIn = (run, testIds) => run.tests.results.filter((r) => r.testId && testIds.includes(r.testId));

  // Latest result per test
  for (const run of runsWithResults) {
    for (const r of run.tests.results) {
      const t = r.testId && tests[r.testId];
      if (!t) continue;
      t.lastResult = { outcome: r.outcome, at: run.completedAt, runId: run.runId, attempt: run.attempt, sha: run.sha, url: run.link, error: r.error ? r.error.summary : null };
      t.runCount = (t.runCount || 0) + 1;
      t.passCount = (t.passCount || 0) + (PASS.has(r.outcome) ? 1 : 0);
      t.failCount = (t.failCount || 0) + (FAIL.has(r.outcome) ? 1 : 0);
    }
  }

  // ── Coverage of each change by a later passing run ─────────────────────────
  function coverageFor(sha, testIds, scope) {
    if (!commits[sha]) return { status: 'unknown', reason: 'The commit is not in the recorded history, so later runs cannot be related to it.' };
    const later = containing(sha);
    const withResults = later.filter((r) => r.tests.available);
    if (scope === 'none') return { status: 'no-linked-tests', reason: 'No test reaches this code through the static call graph, so no run can confirm it.' };
    if (scope === 'global') {
      const executed = withResults.find((r) => r.tests.counts && r.tests.counts.total > 0);
      if (!executed) {
        return later.length
          ? { status: 'not-executed', reason: `${later.length} later run(s) exist but none captured test results.` }
          : { status: 'not-executed', reason: 'No CI run has tested a commit that includes this change yet.' };
      }
      const clean = withResults.find((r) => r.tests.counts.failed + r.tests.counts.timedOut === 0 && r.tests.counts.total > 0);
      return clean
        ? { status: 'executed', reason: 'Affects every test; a later run with this change completed with no failing tests.', run: runRef(clean) }
        : { status: 'failing', reason: 'Affects every test; every later run with this change had failing tests.', run: runRef(executed) };
    }
    if (!testIds.length) return { status: 'no-linked-tests', reason: 'No test is linked to this change.' };
    for (const r of withResults) {
      const hits = outcomeIn(r, testIds);
      const pass = hits.find((h) => PASS.has(h.outcome));
      if (pass) return { status: 'verified', reason: `Linked test "${pass.title}" ${pass.outcome === 'flaky' ? 'passed on retry' : 'passed'} in a run that includes this change.`, run: runRef(r), test: pass.testId };
    }
    const failedRun = withResults.find((r) => outcomeIn(r, testIds).some((h) => FAIL.has(h.outcome)));
    if (failedRun) return { status: 'failing', reason: 'Linked tests ran on a commit that includes this change but did not pass.', run: runRef(failedRun) };
    if (withResults.length) return { status: 'not-executed', reason: `${withResults.length} later run(s) captured results, but none ran the linked tests.` };
    if (later.length) return { status: 'not-executed', reason: `${later.length} later run(s) exist but none captured test results.` };
    return { status: 'not-executed', reason: 'No CI run has tested a commit that includes this change yet.' };
  }
  function runRef(r) {
    return { runId: r.runId, attempt: r.attempt, at: r.completedAt, sha: r.sha, url: r.link, event: r.event };
  }

  for (const c of codeChanges) {
    if (c.kind === 'class' && c.type === 'modified' && !(c.details && c.details.superClass)) c.coverage = { status: 'not-applicable', reason: 'Class container only; its methods are tracked individually.' };
    else c.coverage = coverageFor(c.sha, c.impact.tests.map((t) => t.testId).filter(Boolean), c.impact.scope);
  }
  for (const c of configChanges) c.coverage = coverageFor(c.sha, c.impact.tests.map((t) => t.testId).filter(Boolean), c.impact.scope === 'unknown' ? 'none' : c.impact.scope);
  for (const t of testChanges) {
    if (t.type === 'deleted') t.coverage = { status: 'not-applicable', reason: 'Test was removed.' };
    else t.coverage = coverageFor(t.sha, [t.testId], 'linked');
  }

  // ── Insights ───────────────────────────────────────────────────────────────
  const recent = [...runsWithResults].reverse();
  const insights = { repeatedFailures: [], flaky: [], consistentlySkipped: [], newFailures: [], ongoingFailures: [], pipelineFailures: [], coverageGaps: [], neverExecutedTests: [] };

  const last5 = recent.slice(0, 5);
  const failureTally = new Map();
  for (const run of last5) {
    for (const r of run.tests.results) {
      if (!FAIL.has(r.outcome)) continue;
      const id = r.testId || r.key;
      if (!failureTally.has(id)) failureTally.set(id, { testId: r.testId, key: r.key, title: r.title, file: r.file, runs: [] });
      failureTally.get(id).runs.push({ ...runRef(run), outcome: r.outcome, error: r.error ? r.error.summary : null });
    }
  }
  for (const f of failureTally.values()) {
    if (f.runs.length >= 2) insights.repeatedFailures.push({ ...f, count: f.runs.length, window: last5.length, why: `Failed in ${f.runs.length} of the last ${last5.length} runs that captured results.` });
  }

  const last10 = recent.slice(0, 10);
  const flakyMap = new Map();
  for (const run of last10) {
    for (const r of run.tests.results) {
      const id = r.testId || r.key;
      if (!flakyMap.has(id)) flakyMap.set(id, { testId: r.testId, key: r.key, title: r.title, file: r.file, retryPasses: [], bySha: new Map() });
      const entry = flakyMap.get(id);
      if (r.outcome === 'flaky') entry.retryPasses.push(runRef(run));
      if (!entry.bySha.has(run.sha)) entry.bySha.set(run.sha, new Set());
      entry.bySha.get(run.sha).add(PASS.has(r.outcome) ? 'pass' : FAIL.has(r.outcome) ? 'fail' : 'other');
    }
  }
  for (const f of flakyMap.values()) {
    const mixedShas = [...f.bySha.entries()].filter(([, s]) => s.has('pass') && s.has('fail')).map(([sha]) => sha);
    if (f.retryPasses.length) insights.flaky.push({ testId: f.testId, key: f.key, title: f.title, file: f.file, confidence: 'confirmed', why: `Failed and then passed on retry in ${f.retryPasses.length} of the last ${last10.length} runs (Playwright marked it "flaky").`, runs: f.retryPasses });
    else if (mixedShas.length) insights.flaky.push({ testId: f.testId, key: f.key, title: f.title, file: f.file, confidence: 'possible', why: `Both passed and failed on the same commit (${mixedShas.map((s) => s.slice(0, 7)).join(', ')}) with no code change in between.`, shas: mixedShas });
  }

  const presence = new Map();
  for (const run of recent.slice(0, 10)) {
    for (const r of run.tests.results) {
      const id = r.testId || r.key;
      if (!presence.has(id)) presence.set(id, { testId: r.testId, key: r.key, title: r.title, file: r.file, outcomes: [] });
      presence.get(id).outcomes.push(r.outcome);
    }
  }
  for (const p of presence.values()) {
    if (p.outcomes.length >= 3 && p.outcomes.every((o) => o === 'skipped' || o === 'notRun')) {
      insights.consistentlySkipped.push({ ...p, why: `Skipped in all of its last ${p.outcomes.length} recorded runs.` });
    }
  }

  // New failures: passed in the previous run with results, failed now.
  const lastOutcome = new Map(); // testId|key → { outcome, run }
  const streakStart = new Map();
  for (const run of runsWithResults) {
    for (const r of run.tests.results) {
      // Compare only with earlier runs on the same branch, so PR runs don't mask main.
      const id = `${run.branch || ''}|${r.testId || r.key}`;
      const prev = lastOutcome.get(id);
      if (FAIL.has(r.outcome)) {
        if (prev && PASS.has(prev.outcome)) {
          const candidates = commitsBetween(prev.run.sha, run.sha);
          insights.newFailures.push({
            testId: r.testId,
            key: r.key,
            title: r.title,
            file: r.file,
            run: runRef(run),
            error: r.error ? r.error.summary : null,
            lastPass: runRef(prev.run),
            sameCommit: prev.run.sha === run.sha,
            candidateCommits: candidates === null ? null : candidates.map((sha) => relatedChanges(sha, r.testId, r.key)),
            why: prev.run.sha === run.sha
              ? 'Passed earlier on the same commit; no code changed between the two runs, so the cause is outside the repository (application, environment, data) or the test is flaky. This is not proven.'
              : candidates === null
                ? 'Passed in the previous run; the commits in between could not be determined from the recorded history.'
                : `Passed in the previous run; ${candidates.length} commit(s) landed in between.`,
          });
          streakStart.set(id, { run: runRef(run), lastPass: runRef(prev.run) });
        } else if (!prev) streakStart.set(id, { run: runRef(run), lastPass: null });
      } else if (PASS.has(r.outcome)) streakStart.delete(id);
      if (r.outcome !== 'skipped' && r.outcome !== 'notRun') lastOutcome.set(id, { outcome: r.outcome, run });
    }
  }
  for (const [id, s] of streakStart) {
    const last = lastOutcome.get(id);
    if (!last || !FAIL.has(last.outcome)) continue;
    const testRef = id.slice(id.indexOf('|') + 1);
    const t = tests[testRef] || null;
    insights.ongoingFailures.push({ testId: t ? t.testId : null, key: t ? t.key : testRef, title: t ? t.title : testRef, branch: id.slice(0, id.indexOf('|')), failingSince: s.run, lastPass: s.lastPass, latest: runRef(last.run) });
  }

  function commitsBetween(fromSha, toSha) {
    if (!commits[fromSha] || !commits[toSha]) return null;
    const before = ancestors(fromSha);
    return [...ancestors(toSha)].filter((s) => !before.has(s)).sort((a, b) => position.get(a) - position.get(b));
  }
  function relatedChanges(sha, testId, key) {
    const c = commits[sha] || {};
    const links = [];
    for (const t of testChanges) if (t.sha === sha && (t.testId === testId || t.key === key)) links.push({ kind: 'test-changed', strength: 'direct', text: `The test itself was ${t.type}`, changeId: t.id });
    for (const ch of codeChanges) {
      if (ch.sha !== sha) continue;
      const hit = ch.impact.tests.find((x) => x.testId === testId || x.testKey === key);
      if (hit) links.push({ kind: 'code-changed', strength: hit.evidence === 'static-call' ? 'static-link' : 'possible', text: `${ch.qualifiedName} ${ch.type} — the test reaches it via ${hit.via}`, changeId: ch.id });
      else if (ch.impact.scope === 'global') links.push({ kind: 'code-changed', strength: 'global', text: `${ch.qualifiedName} ${ch.type} (runner-level code, affects all tests)`, changeId: ch.id });
    }
    for (const cf of configChanges) {
      if (cf.sha !== sha) continue;
      const hit = cf.impact.tests.find((x) => x.testId === testId || x.testKey === key);
      if (hit) links.push({ kind: 'data-changed', strength: hit.evidence === 'static-data-reference' ? 'static-link' : 'possible', text: `${cf.file}: ${hit.via}`, changeId: cf.id });
      else if (cf.impact.scope === 'global') links.push({ kind: 'config-changed', strength: 'global', text: `${cf.categoryLabel} changed: ${(cf.summary || []).slice(0, 2).join('; ')}`, changeId: cf.id });
    }
    return { sha, shortSha: sha.slice(0, 7), subject: c.subject, author: c.author, at: c.committedAt, url: c.url, links };
  }

  for (const run of runs) {
    if (PIPELINE_FAILURES.has(run.classification.category)) insights.pipelineFailures.push({ ...runRef(run), category: run.classification.category, label: run.classification.label, stage: run.classification.failureStageLabel, step: run.classification.failedStep });
  }

  // Coverage gaps: latest change of each symbol that is not confirmed by a passing run.
  const latestBySymbol = new Map();
  for (const c of codeChanges) {
    // Classes are covered through their constructor and methods, which are assessed individually.
    if (c.type === 'deleted' || c.kind === 'class' || c.coverage.status === 'not-applicable') continue;
    const prev = latestBySymbol.get(c.symbolId);
    if (!prev || Date.parse(c.at) >= Date.parse(prev.at)) latestBySymbol.set(c.symbolId, c);
  }
  for (const c of latestBySymbol.values()) {
    if (!['verified', 'executed'].includes(c.coverage.status)) {
      insights.coverageGaps.push({ changeId: c.id, symbolId: c.symbolId, qualifiedName: c.qualifiedName, kind: c.kind, file: c.file, type: c.type, at: c.at, sha: c.sha, status: c.coverage.status, why: c.coverage.reason, url: c.links && c.links.file });
    }
  }
  for (const t of Object.values(tests)) {
    if (t.status === 'active' && !t.runCount) insights.neverExecutedTests.push({ testId: t.testId, title: t.title, file: t.file, since: t.firstSeen });
  }

  // ── Daily trend (IST calendar days) ────────────────────────────────────────
  const daily = new Map();
  const day = (at) => {
    const k = istDateKey(at);
    if (!daily.has(k)) daily.set(k, { date: k, commits: 0, testsAdded: 0, testsModified: 0, testsDeleted: 0, testsRenamed: 0, codeChanges: 0, configChanges: 0, runs: 0, runsPassed: 0, runsTestsFailed: 0, runsPipelineFailed: 0, runsOther: 0, testsPassed: 0, testsFailed: 0, testsFlaky: 0, testsSkipped: 0 });
    return daily.get(k);
  };
  for (const c of Object.values(commits)) if (!c.baseline) day(c.committedAt).commits++;
  for (const t of testChanges) {
    const d = day(t.at);
    if (t.type === 'added') d.testsAdded++;
    else if (t.type === 'modified') d.testsModified++;
    else if (t.type === 'deleted') d.testsDeleted++;
    else d.testsRenamed++;
  }
  for (const c of codeChanges) day(c.at).codeChanges++;
  for (const c of configChanges) day(c.at).configChanges++;
  for (const r of runs) {
    const d = day(r.completedAt);
    d.runs++;
    const cat = r.classification.category;
    if (cat === 'passed' || cat === 'passed-with-flaky') d.runsPassed++;
    else if (cat === 'tests-failed') d.runsTestsFailed++;
    else if (PIPELINE_FAILURES.has(cat)) d.runsPipelineFailed++;
    else d.runsOther++;
    if (r.tests.available) {
      d.testsPassed += r.tests.counts.passed;
      d.testsFailed += r.tests.counts.failed + r.tests.counts.timedOut;
      d.testsFlaky += r.tests.counts.flaky;
      d.testsSkipped += r.tests.counts.skipped;
    }
  }

  // ── Data quality notes ─────────────────────────────────────────────────────
  const dataQuality = [];
  const noResults = runs.filter((r) => !r.tests.available);
  if (noResults.length) {
    const reasons = {};
    noResults.forEach((r) => (reasons[r.tests.reason] = (reasons[r.tests.reason] || 0) + 1));
    dataQuality.push({ kind: 'runs-without-results', count: noResults.length, text: `${noResults.length} run(s) have no captured test results; their pass/fail counts are unknown (not zero).`, reasons });
  }
  const partial = runs.filter((r) => r.tests.available && r.tests.fidelity === 'partial');
  if (partial.length) dataQuality.push({ kind: 'partial-results', count: partial.length, text: `${partial.length} run(s) use results recovered from raw Allure files (retry details approximate).` });
  const unknownCommitRuns = runs.filter((r) => !r.commitKnown);
  if (unknownCommitRuns.length) dataQuality.push({ kind: 'runs-on-unrecorded-commits', count: unknownCommitRuns.length, text: `${unknownCommitRuns.length} run(s) tested commits that are not in the recorded history (cannot be linked to changes).` });
  if (baselines.length) dataQuality.push({ kind: 'baseline', count: baselines.length, text: 'History collection started part-way through the repository; tests that existed before are marked as baseline.' });
  if (storeStats && storeStats.invalid) dataQuality.push({ kind: 'invalid-lines', count: storeStats.invalid, text: `${storeStats.invalid} malformed history line(s) were skipped.`, problems: storeStats.problems.slice(0, 20) });

  const allTimes = events.map((e) => e.occurredAt).sort();
  const activeTests = Object.values(tests).filter((t) => t.status === 'active');
  return {
    format: 'qa-intel-index',
    schemaVersion: SCHEMA_VERSION,
    builtAt: now.toISOString(),
    repo: repoName,
    timezone: 'Asia/Kolkata',
    eventCount: events.length,
    history: {
      firstEventAt: allTimes[0] || null,
      lastEventAt: allTimes[allTimes.length - 1] || null,
      firstCommitAt: order.length ? commits[order[0]].committedAt : null,
      lastCommitAt: order.length ? commits[order[order.length - 1]].committedAt : null,
      firstRunAt: runs.length ? runs[0].completedAt : null,
      lastRunAt: runs.length ? runs[runs.length - 1].completedAt : null,
    },
    totals: {
      commits: Object.values(commits).filter((c) => !c.baseline).length,
      activeTests: activeTests.length,
      deletedTests: Object.values(tests).length - activeTests.length,
      testChanges: testChanges.length,
      codeChanges: codeChanges.length,
      configChanges: configChanges.length,
      runs: runs.length,
      runsWithResults: runsWithResults.length,
      scheduledRuns: runs.filter((r) => r.isScheduled).length,
    },
    commitOrder: order,
    commits,
    tests,
    keyToId,
    testChanges: testChanges.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    codeChanges: codeChanges.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    configChanges: configChanges.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    runs: runs.reverse(),
    insights,
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    dataQuality,
  };
}

module.exports = { buildIndex, PASS, FAIL, PIPELINE_FAILURES };

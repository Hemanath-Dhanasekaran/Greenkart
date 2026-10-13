/*
 * Natural-language questions → deterministic queries over the QA index.
 *
 * The question is only used to pick a query and its filters (intent, IST date
 * range, run trigger type, test name, commit sha). Every number, date and
 * status in an answer comes from recorded history; when something cannot be
 * verified the answer says what is missing instead of guessing.
 *
 * Shared by the Node CLI and the browser dashboard (UMD wrapper, no deps
 * besides time.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./time'));
  else root.QAQuery = factory(root.QATime);
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';

  const PASS = ['passed', 'flaky'];
  const FAIL = ['failed', 'timedOut', 'interrupted'];
  const EVENT_LABELS = { schedule: 'scheduled', workflow_dispatch: 'manual', push: 'push', pull_request: 'pull request', pull_request_target: 'pull request', workflow_run: 'workflow-run', repository_dispatch: 'API-triggered' };
  const STATUS_TEXT = {
    verified: 'Confirmed: a linked test passed on a commit that includes this change',
    executed: 'Runner-level change: a later run completed without failing tests',
    failing: 'Linked tests ran after this change but did not pass',
    'not-executed': 'Not yet tested by any run that includes this change',
    'no-linked-tests': 'No test is linked to this code',
    unknown: 'Cannot be determined from recorded history',
    'not-applicable': 'Not applicable',
  };
  const COVERAGE_TONE = { verified: 'good', executed: 'good', failing: 'bad', 'not-executed': 'warn', 'no-linked-tests': 'warn', unknown: 'muted', 'not-applicable': 'muted' };
  const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20 };

  let REPO = null; // set per ask() from the index, used for commit links
  let TESTS = {}; // testId → test, so impact lists show a test's current title
  const when = (at) => T.formatIst(at);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
  const shortSha = (s) => (s ? s.slice(0, 7) : 'unknown');

  function runName(r) {
    return `${EVENT_LABELS[r.event] || r.event} run #${r.runNumber || r.runId}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''}`;
  }
  function failingCount(c) {
    return c ? c.failed + c.timedOut + (c.interrupted || 0) : 0;
  }
  function countsText(t) {
    if (!t.available) return `test results not captured (${t.reason}) — counts unknown`;
    const c = t.counts;
    const parts = [`${c.passed} passed`, `${c.failed} failed`];
    if (c.timedOut) parts.push(`${c.timedOut} timed out`);
    if (c.flaky) parts.push(`${c.flaky} flaky (passed on retry)`);
    if (c.skipped) parts.push(`${c.skipped} skipped`);
    if (c.interrupted) parts.push(`${c.interrupted} interrupted`);
    return `${c.total} tests: ${parts.join(', ')}`;
  }
  function runTone(r) {
    const cat = r.classification.category;
    if (cat === 'passed') return 'good';
    if (cat === 'passed-with-flaky') return 'warn';
    if (cat === 'tests-failed') return 'bad';
    if (/setup|install|workflow-error|infrastructure/.test(cat)) return 'pipeline';
    return 'muted';
  }
  function prLinks(prs) {
    return (prs || []).map((p) => ({ label: `PR #${p.number}`, url: p.url }));
  }
  function reportLinkList(r) {
    const out = [{ label: 'Workflow run', url: r.link }];
    const rep = r.reports || {};
    for (const key of ['playwrightReport', 'allureReport']) {
      const a = rep[key];
      if (a) out.push({ label: `${a.label}${a.expired ? ' (expired)' : ''}`, url: a.url, expired: a.expired });
    }
    return out;
  }

  // ── Filters extracted from the question ───────────────────────────────────
  function detectEvent(q) {
    if (/\bschedul/.test(q) || /\bnightly\b|\bcron\b/.test(q)) return 'schedule';
    if (/\bmanual(ly)?\b|workflow[_ ]dispatch/.test(q)) return 'workflow_dispatch';
    if (/\bpull[ -]?requests?\b|\bprs?\b/.test(q)) return 'pull_request';
    if (/\bpush(ed)?\b/.test(q)) return 'push';
    return null;
  }
  function detectCount(q, fallback) {
    const m = q.match(/\b(?:last|past|previous|recent)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)\s+(?:\w+\s+)?(?:runs?|executions?|builds?|pipelines?|workflow runs?)/);
    if (!m) return fallback;
    return /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  }
  function detectSha(q) {
    const m = q.match(/\b([0-9a-f]{7,40})\b/);
    return m && /[a-f]/.test(m[1]) && /\d/.test(m[1]) ? m[1] : null;
  }
  function detectBranch(q) {
    const m = q.match(/\b(?:on|in|for) (?:the )?branch ([\w./-]+)|\bbranch[: ]+([\w./-]+)/);
    return m ? m[1] || m[2] : null;
  }
  function detectAuthor(q) {
    const m = q.match(/\bby ([a-z0-9][\w .-]{1,40}?)(?:\s+(?:this|last|in|on|during|since|yesterday|today)\b|$)/);
    if (!m) return null;
    const name = m[1].trim();
    return /^(the|a|an|commit|test|run)$/.test(name) ? null : name;
  }
  function quoted(q) {
    const m = q.match(/["“'‘]([^"”'’]{3,})["”'’]/);
    return m ? m[1] : null;
  }
  function tokens(s) {
    return String(s).toLowerCase().split(/[^a-z0-9@]+/).filter((w) => w.length > 1);
  }
  const STOP = new Set(['what', 'which', 'test', 'tests', 'the', 'did', 'does', 'why', 'fail', 'failed', 'failing', 'failure', 'this', 'that', 'commit', 'introduced', 'caused', 'case', 'for', 'of', 'show', 'history', 'me', 'about', 'tell', 'is', 'was', 'in', 'when', 'and', 'run', 'runs', 'latest', 'last']);
  function findTest(index, q) {
    const tests = Object.values(index.tests || {});
    const wanted = quoted(q);
    if (wanted) {
      const exact = tests.find((t) => t.title.toLowerCase() === wanted.toLowerCase()) || tests.find((t) => t.title.toLowerCase().includes(wanted.toLowerCase()));
      if (exact) return exact;
    }
    const words = tokens(q).filter((w) => !STOP.has(w));
    if (!words.length) return null;
    let best = null;
    for (const t of tests) {
      const tw = new Set(tokens(`${t.title} ${t.file}`));
      const hits = words.filter((w) => tw.has(w)).length;
      const score = hits / words.length;
      if (hits && (!best || score > best.score || (score === best.score && t.status === 'active'))) best = { t, score };
    }
    return best && best.score >= 0.5 ? best.t : null;
  }

  function inRange(at, range) {
    return !range || T.inRange(at, range);
  }

  function freshnessNotes(index, range) {
    const notes = [];
    if (range && index.history.firstEventAt && Date.parse(range.start) < Date.parse(index.history.firstEventAt)) {
      notes.push(`Recorded history starts on ${when(index.history.firstEventAt)}; nothing earlier is available.`);
    }
    if (range && Date.parse(range.end) > Date.parse(index.builtAt)) {
      notes.push(`History was last refreshed ${when(index.builtAt)}; anything after that is not included yet.`);
    }
    return notes;
  }

  function scope(base, list, { range, branch, author } = {}) {
    return list.filter((x) => inRange(x.at, range)
      && (!branch || (x.branch || '').toLowerCase() === branch.toLowerCase())
      && (!author || `${x.author || ''} ${x.authorLogin || ''}`.toLowerCase().includes(author.toLowerCase())));
  }

  function rangeLabel(range) {
    return range ? `${range.label} (${range.description})` : 'in all recorded history';
  }

  // ── Item builders ─────────────────────────────────────────────────────────
  const testName = (t) => (t.testId && TESTS[t.testId] ? TESTS[t.testId].title : t.testKey.split(' > ').pop());

  function testChangeItem(c) {
    const typeText = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', moved: 'Moved' }[c.type];
    const lines = [];
    if (c.type === 'renamed' || c.type === 'moved') lines.push(`Was: "${c.previousTitle}"${c.previousFile && c.previousFile !== c.file ? ` in ${c.previousFile}` : ''}`);
    (c.summary || []).forEach((s) => lines.push(s));
    if (c.coverage && c.type !== 'deleted') lines.push(`Execution: ${STATUS_TEXT[c.coverage.status]}${c.coverage.run ? ` — ${EVENT_LABELS[c.coverage.run.event] || ''} run ${c.coverage.run.runId} (${when(c.coverage.run.at)})` : ''}`);
    return {
      kind: 'test-change',
      title: c.title,
      subtitle: c.file,
      when: when(c.at),
      at: c.at,
      badges: [{ text: typeText, tone: c.type === 'deleted' ? 'bad' : c.type === 'added' ? 'good' : 'info' }, c.evidence && c.evidence.confidence !== 'confirmed' ? { text: `${c.evidence.confidence}: ${c.evidence.basis}`, tone: 'warn' } : null, c.coverage && c.type !== 'deleted' ? { text: c.coverage.status, tone: COVERAGE_TONE[c.coverage.status] } : null].filter(Boolean),
      lines,
      meta: `commit ${c.shortSha} by ${c.author || 'unknown'}${c.branch ? ` on ${c.branch}` : ''}`,
      links: [{ label: `Commit ${c.shortSha}`, url: c.links && c.links.commit }, { label: 'Test source', url: c.links && c.links.file }, ...prLinks(c.pullRequests)].filter((l) => l.url),
      evidence: c.evidence ? c.evidence.confidence : 'confirmed',
      details: { testId: c.testId, key: c.key, evidence: c.evidence, details: c.details, coverage: c.coverage },
    };
  }
  function codeChangeItem(c) {
    const lines = [...(c.summary || [])];
    if (c.impact) {
      if (c.impact.scope === 'linked') lines.push(`Affects ${plural(c.impact.tests.length, 'test')} (static call graph): ${c.impact.tests.slice(0, 4).map(testName).join('; ')}${c.impact.tests.length > 4 ? '…' : ''}`);
      else if (c.impact.scope === 'global') lines.push('Runner-level code: can affect every test (inferred).');
      else lines.push('No test reaches this code (static call graph).');
    }
    if (c.coverage) lines.push(`Coverage: ${STATUS_TEXT[c.coverage.status]}`);
    return {
      kind: 'code-change',
      title: c.qualifiedName,
      subtitle: `${c.categoryLabel} · ${c.file}`,
      when: when(c.at),
      at: c.at,
      badges: [{ text: `${c.kind} ${c.type}`, tone: c.type === 'deleted' ? 'bad' : c.type === 'added' ? 'good' : 'info' }, c.evidence && c.evidence.confidence !== 'confirmed' ? { text: `${c.evidence.confidence}: ${c.evidence.basis}`, tone: 'warn' } : null, c.coverage && c.coverage.status !== 'not-applicable' ? { text: c.coverage.status, tone: COVERAGE_TONE[c.coverage.status] } : null].filter(Boolean),
      lines,
      meta: `commit ${c.shortSha} by ${c.author || 'unknown'}${c.branch ? ` on ${c.branch}` : ''}`,
      links: [{ label: `Commit ${c.shortSha}`, url: c.links && c.links.commit }, { label: 'Source', url: c.links && c.links.file }, ...prLinks(c.pullRequests)].filter((l) => l.url),
      evidence: c.evidence ? c.evidence.confidence : 'confirmed',
      details: { symbolId: c.symbolId, previous: c.previous, details: c.details, impact: c.impact, coverage: c.coverage },
    };
  }
  function configChangeItem(c) {
    return {
      kind: 'config-change',
      title: `${c.categoryLabel}: ${c.file}`,
      subtitle: c.status === 'added' ? 'file added' : c.status === 'deleted' ? 'file deleted' : 'file changed',
      when: when(c.at),
      at: c.at,
      badges: [{ text: c.categoryLabel, tone: 'info' }, c.impact && c.impact.scope === 'global' ? { text: 'affects all tests', tone: 'warn' } : null].filter(Boolean),
      lines: [...(c.summary || []).slice(0, 8), ...(c.impact && c.impact.scope === 'linked' ? [`Linked tests: ${c.impact.tests.map((t) => `${testName(t)} (${t.via})`).join('; ')}`] : [])],
      meta: `commit ${c.shortSha} by ${c.author || 'unknown'}`,
      links: [{ label: `Commit ${c.shortSha}`, url: c.links && c.links.commit }, { label: 'File', url: c.links && c.links.file }, ...prLinks(c.pullRequests)].filter((l) => l.url),
      evidence: 'confirmed',
      details: { details: c.details, impact: c.impact, coverage: c.coverage },
    };
  }
  function runItem(r) {
    // When results are missing, the classification note already says so.
    const lines = r.tests.available ? [countsText(r.tests)] : [];
    if (r.classification.failureStageLabel && r.classification.category !== 'passed') lines.push(`Stopped at: ${r.classification.failureStageLabel}${r.classification.failedStep ? ` — step "${r.classification.failedStep.name}"` : ''}`);
    (r.classification.notes || []).forEach((n) => lines.push(n));
    const failing = (r.tests.results || []).filter((t) => FAIL.includes(t.outcome));
    failing.slice(0, 6).forEach((t) => lines.push(`✗ ${t.title}${t.error && t.error.summary ? ` — ${t.error.summary}` : ''}`));
    if (failing.length > 6) lines.push(`…and ${failing.length - 6} more failing test(s)`);
    return {
      kind: 'run',
      title: `${r.workflow.name} — ${runName(r)}`,
      subtitle: `${r.classification.label} · ${r.branch || '?'} @ ${shortSha(r.sha)}${r.commitSubject ? ` "${r.commitSubject}"` : ''}`,
      when: when(r.completedAt),
      at: r.completedAt,
      badges: [{ text: r.classification.label, tone: runTone(r) }, { text: EVENT_LABELS[r.event] || r.event, tone: 'muted' }, { text: T.formatDuration(r.durationSec), tone: 'muted' }],
      lines,
      meta: `triggered by ${r.triggeringActor || r.actor || 'unknown'}${r.scheduleCron ? ` · cron ${r.scheduleCron}` : ''} · started ${when(r.startedAt)}`,
      links: [...reportLinkList(r), REPO && r.sha ? { label: `Commit ${shortSha(r.sha)}`, url: `https://github.com/${REPO}/commit/${r.sha}` } : null, ...prLinks(r.pullRequests)].filter((l) => l && l.url),
      evidence: 'confirmed',
      details: { runId: r.runId, attempt: r.attempt, classification: r.classification, jobs: r.jobs, tests: { source: r.tests.source, fidelity: r.tests.fidelity, counts: r.tests.counts, globalErrors: r.tests.globalErrors } },
    };
  }

  function base(question, intent, intentLabel, range) {
    return { question, intent, intentLabel, range: range || null, headline: '', points: [], sections: [], missing: [], notes: [] };
  }

  // ── Intents ───────────────────────────────────────────────────────────────
  function answerTestChanges(index, ctx) {
    const { q, range } = ctx;
    const types = [];
    if (/\b(add|added|new|created|introduc)/.test(q)) types.push('added');
    if (/\b(modif|chang|updat|edit)/.test(q)) types.push('modified');
    if (/\b(delet|remov|drop)/.test(q)) types.push('deleted');
    if (/\b(renam)/.test(q)) types.push('renamed');
    if (/\b(mov)/.test(q)) types.push('moved');
    const wanted = types.length ? types : ['added', 'modified', 'deleted', 'renamed', 'moved'];
    const list = scope(index, index.testChanges, ctx).filter((c) => wanted.includes(c.type));
    const a = base(ctx.question, 'test-changes', 'Test case changes', range);
    const verb = types.length === 1 ? { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', moved: 'moved' }[types[0]] : types.length ? types.join(' or ') : 'added, changed or removed';
    a.headline = list.length
      ? `${plural(list.length, 'test case')} ${list.length === 1 ? 'was' : 'were'} ${verb} ${rangeLabel(range)}.`
      : `No test cases were ${verb} ${rangeLabel(range)}.`;
    const byType = {};
    list.forEach((c) => (byType[c.type] = (byType[c.type] || 0) + 1));
    if (list.length && Object.keys(byType).length > 1) a.points.push(Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', '));
    const commitsInvolved = new Set(list.map((c) => c.sha));
    if (list.length) a.points.push(`Across ${plural(commitsInvolved.size, 'commit')}.`);
    const notRun = list.filter((c) => c.coverage && c.coverage.status === 'not-executed');
    if (notRun.length) a.points.push(`${plural(notRun.length, 'change')} not yet executed by a CI run.`);
    a.sections.push({ title: 'Test changes', items: list.map(testChangeItem) });
    a.notes.push('A rename/move is reported instead of delete+add when the test body is identical or very similar; similarity-based matches are marked "inferred".');
    a.missing.push(...freshnessNotes(index, range));
    return a;
  }

  function answerCodeChanges(index, ctx) {
    const { q, range } = ctx;
    const types = [];
    if (/\b(add|added|new|created|introduc)/.test(q)) types.push('added');
    if (/\b(modif|chang|updat|edit)/.test(q)) types.push('modified');
    if (/\b(delet|remov)/.test(q)) types.push('deleted');
    if (/\b(renam|mov)/.test(q)) types.push('renamed');
    const wanted = types.length ? types : ['added', 'modified', 'deleted', 'renamed'];
    let cats = null;
    if (/page ?objects?/.test(q)) cats = ['page-object', 'base-page'];
    else if (/fixture/.test(q)) cats = ['fixture'];
    else if (/helper|utilit/.test(q)) cats = ['utility', 'test-data-utility', 'api-utility', 'logging-utility', 'reporter'];
    else if (/excel|test.?data/.test(q)) cats = ['test-data-utility'];
    else if (/report/.test(q)) cats = ['reporter'];
    else if (/\bapi\b|validat/.test(q)) cats = ['api-utility'];
    const includeConfig = /framework|config|dependenc|package|workflow|pipeline|reporter|everything|all changes/.test(q);
    const classesToo = /class|page ?object/.test(q);
    const list = scope(index, index.codeChanges, ctx)
      .filter((c) => wanted.includes(c.type))
      .filter((c) => !cats || cats.includes(c.category))
      .filter((c) => !(c.kind === 'class' && c.coverage && c.coverage.status === 'not-applicable'))
      .filter((c) => classesToo || c.kind !== 'class' || c.type !== 'modified');
    const configs = includeConfig ? scope(index, index.configChanges, ctx) : [];
    const a = base(ctx.question, 'code-changes', includeConfig ? 'Framework changes' : 'Method and class changes', range);
    const [one, what] = cats && cats[0] === 'page-object' ? ['page-object member', 'page-object members'] : ['method/function', 'methods/functions'];
    if (includeConfig) {
      a.headline = list.length + configs.length
        ? `${plural(list.length, 'code change')} and ${plural(configs.length, 'configuration/dependency/workflow/test-data change')} ${rangeLabel(range)}.`
        : `No framework changes ${rangeLabel(range)}.`;
    } else {
      a.headline = list.length
        ? `${plural(list.length, one, what)} ${list.length === 1 ? 'was' : 'were'} ${wanted.length === 4 ? 'changed' : wanted.join(' or ')} ${rangeLabel(range)}.`
        : `No ${what} were ${wanted.length === 4 ? 'changed' : wanted.join(' or ')} ${rangeLabel(range)}.`;
    }
    const byType = {};
    list.forEach((c) => (byType[c.type] = (byType[c.type] || 0) + 1));
    if (list.length) a.points.push(Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', '));
    const gaps = list.filter((c) => c.coverage && !['verified', 'executed', 'not-applicable'].includes(c.coverage.status));
    if (gaps.length) a.points.push(`${plural(gaps.length, 'change')} not yet confirmed by a passing relevant test run.`);
    a.sections.push({ title: 'Framework code', items: list.map(codeChangeItem) });
    if (includeConfig) a.sections.push({ title: 'Configuration, dependencies, workflows and test data', items: configs.map(configChangeItem) });
    a.notes.push('Only real code changes are listed: edits to comments or formatting are ignored (token-level comparison).');
    a.missing.push(...freshnessNotes(index, range));
    return a;
  }

  function filteredRuns(index, ctx) {
    return index.runs.filter((r) => (!ctx.event || r.event === ctx.event || (ctx.event === 'pull_request' && r.event === 'pull_request_target'))
      && (!ctx.branch || (r.branch || '').toLowerCase() === ctx.branch.toLowerCase())
      && inRange(r.completedAt, ctx.range));
  }

  function noRunsAnswer(index, a, ctx) {
    const label = ctx.event ? `${EVENT_LABELS[ctx.event]} runs` : 'workflow runs';
    a.headline = `No ${label} are recorded${ctx.range ? ` ${rangeLabel(ctx.range)}` : ''}.`;
    if (ctx.event === 'schedule') {
      const sched = index.configChanges.find((c) => c.details && c.details.triggersAfter && c.details.triggersAfter.includes('schedule'));
      a.missing.push(sched ? `A schedule trigger exists since commit ${sched.shortSha} (${when(sched.at)}), but no scheduled execution has been recorded yet.` : 'No recorded workflow change adds a schedule trigger, so scheduled runs may not be configured.');
    }
    if (!index.runs.length) a.missing.push('No CI runs have been collected at all. Run the collector with a GitHub token (it runs automatically in GitHub Actions).');
    a.missing.push(...freshnessNotes(index, ctx.range));
    return a;
  }

  function answerRunDetail(index, ctx) {
    const a = base(ctx.question, 'run-detail', 'Latest run', ctx.range);
    const runs = filteredRuns(index, ctx);
    if (!runs.length) return noRunsAnswer(index, a, ctx);
    const r = runs[0];
    const failing = (r.tests.results || []).filter((t) => FAIL.includes(t.outcome));
    a.headline = `${ctx.event ? `Latest ${EVENT_LABELS[ctx.event]} run` : 'Latest run'} (${when(r.completedAt)}): ${r.classification.label}${r.tests.available ? ` — ${countsText(r.tests)}` : ''}.`;
    a.points.push(`${r.workflow.name} ${runName(r)} on ${r.branch} @ ${shortSha(r.sha)}${r.commitSubject ? ` ("${r.commitSubject}")` : ''}, took ${T.formatDuration(r.durationSec)}.`);
    if (r.isScheduled && r.commitKnown) {
      const prevSched = runs.find((x) => x !== r && x.isScheduled);
      if (prevSched) a.points.push(prevSched.sha === r.sha ? 'No code changed since the previous scheduled run.' : `Code changed since the previous scheduled run (${shortSha(prevSched.sha)} → ${shortSha(r.sha)}).`);
    }
    if (failing.length) a.points.push(`Failing tests: ${failing.map((t) => t.title).join('; ')}`);
    if (!r.tests.available) a.missing.push(`Test results for this run were not captured (${r.tests.reason}). Pass/fail counts are unknown — they are not zero.`);
    a.sections.push({ title: 'Run', items: [runItem(r)] });
    if (r.tests.available && r.tests.results.length) {
      a.sections.push({
        title: 'Individual test outcomes',
        items: r.tests.results.map((t) => ({
          kind: 'test-result',
          title: t.title,
          subtitle: t.file,
          badges: [{ text: t.outcome, tone: PASS.includes(t.outcome) ? (t.outcome === 'flaky' ? 'warn' : 'good') : FAIL.includes(t.outcome) ? 'bad' : 'muted' }, t.retries ? { text: `${t.retries} retr${t.retries === 1 ? 'y' : 'ies'}`, tone: 'warn' } : null, { text: T.formatDuration(t.durationMs / 1000), tone: 'muted' }].filter(Boolean),
          lines: t.error && t.error.summary ? [t.error.summary] : [],
          links: [],
          details: { attempts: t.attempts, error: t.error, testId: t.testId },
        })),
      });
    }
    return a;
  }

  function answerRunsList(index, ctx) {
    const a = base(ctx.question, 'runs', 'CI/CD runs', ctx.range);
    const runs = filteredRuns(index, ctx).slice(0, ctx.count || 50);
    if (!runs.length) return noRunsAnswer(index, a, ctx);
    const cats = {};
    runs.forEach((r) => (cats[r.classification.label] = (cats[r.classification.label] || 0) + 1));
    a.headline = `${plural(runs.length, `${ctx.event ? `${EVENT_LABELS[ctx.event]} ` : ''}run`)} ${ctx.range ? rangeLabel(ctx.range) : '(most recent first)'}.`;
    a.points.push(Object.entries(cats).map(([k, v]) => `${v} × ${k}`).join(' · '));
    a.sections.push({ title: 'Runs', items: runs.map(runItem) });
    a.missing.push(...freshnessNotes(index, ctx.range));
    return a;
  }

  function answerFailuresRecent(index, ctx) {
    const n = ctx.count || 5;
    const a = base(ctx.question, 'recent-failures', `Failures in the last ${n} runs`, ctx.range);
    const runs = filteredRuns(index, ctx).slice(0, n);
    if (!runs.length) return noRunsAnswer(index, a, ctx);
    const withResults = runs.filter((r) => r.tests.available);
    const tally = new Map();
    for (const r of withResults) {
      for (const t of r.tests.results.filter((x) => FAIL.includes(x.outcome))) {
        const k = t.testId || t.key;
        if (!tally.has(k)) tally.set(k, { title: t.title, file: t.file, testId: t.testId, runs: [] });
        tally.get(k).runs.push({ r, t });
      }
    }
    const total = [...tally.values()].reduce((s, x) => s + x.runs.length, 0);
    const pipeline = runs.filter((r) => /setup|install|workflow-error|infrastructure/.test(r.classification.category));
    a.headline = tally.size
      ? `${plural(tally.size, 'test')} failed in the last ${plural(runs.length, `${ctx.event ? `${EVENT_LABELS[ctx.event]} ` : ''}execution`)} (${plural(total, 'failure')} in total).`
      : withResults.length
        ? `No tests failed in the last ${plural(runs.length, 'execution')} that captured results.`
        : `None of the last ${plural(runs.length, 'execution')} captured test results, so failures cannot be determined.`;
    if (pipeline.length) a.points.push(`${plural(pipeline.length, 'run')} failed before tests ran (pipeline problem, not a test failure).`);
    const missing = runs.filter((r) => !r.tests.available);
    if (missing.length) a.missing.push(`${plural(missing.length, 'run')} in this window have no test results (${[...new Set(missing.map((r) => r.tests.reason))].join('; ')}). Their failures are unknown, not zero.`);
    a.sections.push({
      title: 'Failing tests',
      items: [...tally.values()].sort((x, y) => y.runs.length - x.runs.length).map((f) => ({
        kind: 'failing-test',
        title: f.title,
        subtitle: f.file,
        badges: [{ text: `failed in ${f.runs.length}/${withResults.length} runs`, tone: 'bad' }],
        lines: f.runs.map(({ r, t }) => `${when(r.completedAt)} · ${runName(r)} @ ${shortSha(r.sha)} · ${t.outcome}${t.error && t.error.summary ? ` — ${t.error.summary}` : ''}`),
        links: f.runs.slice(0, 3).map(({ r }) => ({ label: `Run ${r.runId}`, url: r.link })),
        evidence: 'confirmed',
        details: { testId: f.testId },
      })),
    });
    a.sections.push({ title: 'Runs considered', items: runs.map(runItem) });
    return a;
  }

  const STRENGTH_ORDER = { direct: 0, 'static-link': 1, possible: 2, global: 3 };
  function rankCandidates(cands) {
    return cands.map((c) => ({ ...c, best: c.links.length ? Math.min(...c.links.map((l) => STRENGTH_ORDER[l.strength] ?? 4)) : 5 })).sort((x, y) => x.best - y.best);
  }
  const STRENGTH_TEXT = ['the test itself changed', 'it changed code or data the test uses (static link)', 'it changed something the test may depend on', 'it changed runner-level configuration', '', 'no recorded change links it to this test'];

  function answerFailureOrigin(index, ctx) {
    const a = base(ctx.question, 'failure-origin', 'Which commit introduced a failure', ctx.range);
    const test = findTest(index, ctx.q);
    let list = index.insights.newFailures;
    if (test) list = list.filter((f) => f.testId === test.testId);
    list = [...list].sort((x, y) => Date.parse(y.run.at) - Date.parse(x.run.at));
    if (!list.length) {
      const ongoing = index.insights.ongoingFailures.filter((f) => !test || f.testId === test.testId);
      if (ongoing.length) {
        a.headline = `${test ? `"${test.title}"` : 'The failing tests'} ${ongoing.length === 1 && !test ? 'has' : 'have'} been failing since the first recorded run, so there is no earlier passing run to compare with.`;
        a.sections.push({ title: 'Ongoing failures', items: ongoing.map((o) => ({ kind: 'failure', title: o.title, subtitle: o.key, lines: [`Failing since ${when(o.failingSince.at)} (run ${o.failingSince.runId})`, `Latest failure ${when(o.latest.at)}`], links: [{ label: 'First failing run', url: o.failingSince.url }], evidence: 'confirmed' })) });
        a.missing.push('A commit can only be suspected when a passing run exists before the first failure.');
        return a;
      }
      a.headline = test ? `No recorded failure of "${test.title}" follows a passing run.` : 'No test has gone from passing to failing in the recorded runs.';
      if (!index.totals.runsWithResults) a.missing.push('No runs with captured test results are recorded yet.');
      return a;
    }
    const f = list[0];
    const cands = f.candidateCommits ? rankCandidates(f.candidateCommits) : null;
    a.points.push(`"${f.title}" passed in run ${f.lastPass.runId} (${when(f.lastPass.at)} @ ${shortSha(f.lastPass.sha)}) and failed in run ${f.run.runId} (${when(f.run.at)} @ ${shortSha(f.run.sha)}).`);
    if (f.error) a.points.push(`Error: ${f.error}`);
    if (f.sameCommit) {
      a.headline = `No commit introduced it: "${f.title}" passed and then failed on the same commit ${shortSha(f.run.sha)}.`;
      a.points.push(f.why);
    } else if (!cands) {
      a.headline = `"${f.title}" started failing in run ${f.run.runId}, but the commits between the last pass and the failure are not in the recorded history.`;
      a.missing.push('Commit history between the two runs is missing (e.g. a run on an unrecorded branch).');
    } else if (!cands.length) {
      a.headline = `No new commits between the last pass and the failure of "${f.title}".`;
    } else {
      const top = cands[0];
      a.headline = top.best <= 3
        ? `Most likely related commit: ${top.shortSha} "${top.subject}" by ${top.author || 'unknown'} — ${STRENGTH_TEXT[top.best]}.`
        : `${plural(cands.length, 'commit')} landed between the last pass and the failure, but none changed anything this test is known to use.`;
      a.notes.push('This is a correlation based on what changed between the last passing and first failing run. It is not proof of cause.');
    }
    if (cands && cands.length) {
      a.sections.push({
        title: 'Commits between the last pass and the failure',
        items: cands.map((c) => ({
          kind: 'candidate-commit',
          title: `${c.shortSha} ${c.subject || ''}`,
          subtitle: `${c.author || 'unknown'} · ${when(c.at)}`,
          badges: [{ text: c.best <= 1 ? 'strong link' : c.best <= 3 ? 'weak link' : 'no link', tone: c.best <= 1 ? 'bad' : c.best <= 3 ? 'warn' : 'muted' }],
          lines: c.links.length ? c.links.map((l) => `${l.strength}: ${l.text}`) : ['No recorded change in this commit is linked to the test.'],
          links: [{ label: 'Commit', url: c.url }],
          evidence: c.best <= 1 ? 'correlation (static evidence)' : 'correlation',
        })),
      });
    }
    if (list.length > 1) {
      a.sections.push({ title: 'Other pass→fail transitions', items: list.slice(1, 10).map((x) => ({ kind: 'failure', title: x.title, subtitle: `failed ${when(x.run.at)} in run ${x.run.runId}`, lines: [x.why], links: [{ label: 'Failing run', url: x.run.url }], evidence: 'confirmed' })) });
    }
    return a;
  }

  function answerCoverageGaps(index, ctx) {
    const a = base(ctx.question, 'coverage-gaps', 'Changed code without a successful relevant test run', ctx.range);
    const gaps = index.insights.coverageGaps.filter((g) => inRange(g.at, ctx.range));
    const by = {};
    gaps.forEach((g) => (by[g.status] = (by[g.status] || 0) + 1));
    a.headline = gaps.length
      ? `${plural(gaps.length, 'changed method/function', 'changed methods/functions')} ${gaps.length === 1 ? 'has' : 'have'} not been confirmed by a successful relevant test run${ctx.range ? ` ${rangeLabel(ctx.range)}` : ''}.`
      : `Every changed method${ctx.range ? ` ${rangeLabel(ctx.range)}` : ''} has been exercised by a passing linked test (or no methods changed).`;
    const labels = { 'no-linked-tests': 'not called by any test', 'not-executed': 'linked tests not yet run on that change', failing: 'linked tests ran but failed', unknown: 'cannot be determined' };
    if (gaps.length) a.points.push(Object.entries(by).map(([k, v]) => `${v} ${labels[k] || k}`).join(' · '));
    const changeById = new Map(index.codeChanges.map((c) => [c.id, c]));
    a.sections.push({ title: 'Coverage gaps', items: gaps.map((g) => { const c = changeById.get(g.changeId); return c ? codeChangeItem(c) : { title: g.qualifiedName, lines: [g.why] }; }) });
    a.notes.push('"Linked" means a test reaches the method through the static call graph (test → page object → helper). Sharing a file is not counted as coverage.');
    a.notes.push('Only the latest change of each method is assessed; a later passing run that includes the change confirms it.');
    if (!index.totals.runsWithResults) a.missing.push('No runs with captured test results are recorded, so no change can be confirmed yet.');
    return a;
  }

  function answerCommit(index, ctx) {
    const a = base(ctx.question, 'commit', 'QA activity for a commit', null);
    const matches = Object.values(index.commits).filter((c) => c.sha.startsWith(ctx.sha.toLowerCase()));
    if (!matches.length) {
      a.headline = `Commit ${ctx.sha} is not in the recorded history.`;
      a.missing.push('It may be on a branch that was not collected, or newer than the last refresh.');
      return a;
    }
    const c = matches[0];
    const tc = index.testChanges.filter((x) => x.sha === c.sha);
    const cc = index.codeChanges.filter((x) => x.sha === c.sha);
    const cf = index.configChanges.filter((x) => x.sha === c.sha);
    const exactRuns = index.runs.filter((r) => r.sha === c.sha);
    a.headline = `Commit ${c.shortSha} "${c.subject}" by ${c.author || 'unknown'} (${when(c.committedAt)}): ${plural(tc.length, 'test change')}, ${plural(cc.length, 'code change')}, ${plural(cf.length, 'config/data change')}; ${exactRuns.length ? `${plural(exactRuns.length, 'run')} executed against it` : 'no run executed exactly this commit'}.`;
    if (c.pullRequests && c.pullRequests.length) a.points.push(`Pull request(s): ${c.pullRequests.map((p) => `#${p.number} ${p.title}`).join(', ')}`);
    else if (c.pullRequests === null) a.missing.push('Pull-request association was not looked up for this commit.');
    a.points.push(`Files: ${(c.files || []).map((f) => `${f.path} (${f.status}${f.note ? `; ${f.note}` : ''})`).join(', ')}`);
    a.sections.push({ title: 'Test cases', items: tc.map(testChangeItem) });
    a.sections.push({ title: 'Framework code', items: cc.map(codeChangeItem) });
    a.sections.push({ title: 'Configuration, dependencies, workflows and test data', items: cf.map(configChangeItem) });
    a.sections.push({ title: 'Runs on this exact commit', items: exactRuns.map(runItem) });
    return a;
  }

  function answerSummary(index, ctx) {
    const range = ctx.range || T.weekRange(ctx.now, 0, 'this week');
    const c2 = { ...ctx, range };
    const a = base(ctx.question, 'summary', 'Automation progress summary', range);
    const commits = Object.values(index.commits).filter((c) => !c.baseline && inRange(c.committedAt, range));
    const tc = scope(index, index.testChanges, c2);
    const cc = scope(index, index.codeChanges, c2).filter((c) => !(c.kind === 'class' && c.type === 'modified'));
    const cf = scope(index, index.configChanges, c2);
    const runs = index.runs.filter((r) => inRange(r.completedAt, range));
    const t = (type) => tc.filter((x) => x.type === type).length;
    const cats = {};
    runs.forEach((r) => (cats[r.classification.label] = (cats[r.classification.label] || 0) + 1));
    const withRes = runs.filter((r) => r.tests.available);
    const tp = withRes.reduce((s, r) => s + r.tests.counts.passed + r.tests.counts.flaky, 0);
    const tt = withRes.reduce((s, r) => s + r.tests.counts.total - r.tests.counts.skipped, 0);
    a.headline = `${range.label[0].toUpperCase()}${range.label.slice(1)} (${range.description}): ${plural(commits.length, 'commit')}, ${plural(t('added'), 'test')} added, ${plural(cc.length, 'code change')}, ${plural(runs.length, 'CI run')}${withRes.length ? ` with a ${pct(tp, tt)} test pass rate` : ''}.`;
    a.points.push(`Tests: ${t('added')} added, ${t('modified')} modified, ${t('renamed') + t('moved')} renamed/moved, ${t('deleted')} deleted. Active tests now: ${index.totals.activeTests}.`);
    a.points.push(`Framework: ${cc.filter((x) => x.type === 'added').length} methods/classes added, ${cc.filter((x) => x.type === 'modified').length} modified, ${cc.filter((x) => x.type === 'deleted').length} deleted; ${plural(cf.length, 'config/dependency/workflow/data change')}.`);
    if (runs.length) a.points.push(`CI: ${Object.entries(cats).map(([k, v]) => `${v} × ${k}`).join(' · ')}.`);
    const newF = index.insights.newFailures.filter((f) => inRange(f.run.at, range));
    if (newF.length) a.points.push(`${plural(newF.length, 'test')} went from passing to failing.`);
    const gaps = index.insights.coverageGaps.filter((g) => inRange(g.at, range));
    if (gaps.length) a.points.push(`${plural(gaps.length, 'changed method')} not yet confirmed by a passing linked test.`);
    if (runs.length - withRes.length) a.missing.push(`${plural(runs.length - withRes.length, 'run')} in this period have no captured test results; the pass rate covers only runs with results.`);
    a.sections.push({ title: 'Test changes', items: tc.map(testChangeItem) });
    a.sections.push({ title: 'Framework code', items: cc.map(codeChangeItem) });
    a.sections.push({ title: 'Configuration and data', items: cf.map(configChangeItem) });
    a.sections.push({ title: 'CI runs', items: runs.map(runItem) });
    a.missing.push(...freshnessNotes(index, range));
    return a;
  }

  function answerCompare(index, ctx) {
    const a = base(ctx.question, 'compare-runs', 'Run comparison', ctx.range);
    const runs = filteredRuns(index, ctx);
    if (runs.length < 2) {
      noRunsAnswer(index, a, ctx);
      if (runs.length === 1) a.headline = `Only one ${ctx.event ? `${EVENT_LABELS[ctx.event]} ` : ''}run is recorded, so there is nothing to compare it with.`;
      return a;
    }
    const [cur, prev] = runs;
    a.sections.push({ title: 'Runs compared', items: [runItem(cur), runItem(prev)] });
    if (!cur.tests.available || !prev.tests.available) {
      a.headline = `Compared ${runName(cur)} (${when(cur.completedAt)}) with ${runName(prev)} (${when(prev.completedAt)}): ${cur.classification.label} vs ${prev.classification.label}. Test-level comparison is not possible.`;
      a.missing.push(`${!cur.tests.available ? 'The latest' : 'The previous'} run has no captured test results.`);
      return a;
    }
    const map = (r) => new Map(r.tests.results.map((t) => [t.testId || t.key, t]));
    const mc = map(cur);
    const mp = map(prev);
    const newlyFailing = [];
    const fixed = [];
    const stillFailing = [];
    const added = [];
    const removed = [];
    for (const [k, t] of mc) {
      const p = mp.get(k);
      if (!p) added.push(t);
      else if (FAIL.includes(t.outcome) && !FAIL.includes(p.outcome)) newlyFailing.push(t);
      else if (!FAIL.includes(t.outcome) && FAIL.includes(p.outcome)) fixed.push(t);
      else if (FAIL.includes(t.outcome)) stillFailing.push(t);
    }
    for (const [k, t] of mp) if (!mc.has(k)) removed.push(t);
    const cf = failingCount(cur.tests.counts);
    const pf = failingCount(prev.tests.counts);
    a.headline = `Latest${ctx.event ? ` ${EVENT_LABELS[ctx.event]}` : ''} run: ${cf} failing of ${cur.tests.counts.total} vs ${pf} failing of ${prev.tests.counts.total} in the previous one — ${newlyFailing.length} newly failing, ${fixed.length} fixed.`;
    a.points.push(`Latest: ${countsText(cur.tests)} (${when(cur.completedAt)}, ${T.formatDuration(cur.durationSec)}).`);
    a.points.push(`Previous: ${countsText(prev.tests)} (${when(prev.completedAt)}, ${T.formatDuration(prev.durationSec)}).`);
    a.points.push(cur.sha === prev.sha ? 'Both runs tested the same commit — differences are not caused by code changes.' : `Code changed between the runs: ${shortSha(prev.sha)} → ${shortSha(cur.sha)}.`);
    const item = (t, tone, text) => ({ kind: 'test-result', title: t.title, subtitle: t.file, badges: [{ text, tone }], lines: t.error && t.error.summary ? [t.error.summary] : [], links: [], evidence: 'confirmed' });
    a.sections.push({ title: 'Newly failing', items: newlyFailing.map((t) => item(t, 'bad', t.outcome)) });
    a.sections.push({ title: 'Fixed (failed before, passing now)', items: fixed.map((t) => item(t, 'good', t.outcome)) });
    a.sections.push({ title: 'Still failing', items: stillFailing.map((t) => item(t, 'bad', t.outcome)) });
    a.sections.push({ title: 'Only in the latest run', items: added.map((t) => item(t, 'info', t.outcome)) });
    a.sections.push({ title: 'Only in the previous run', items: removed.map((t) => item(t, 'muted', t.outcome)) });
    return a;
  }

  function answerInsights(index, ctx) {
    const a = base(ctx.question, 'insights', 'QA risks and quality insights', null);
    const { q } = ctx;
    const ins = index.insights;
    const want = (k) => !/flaky|skip|repeat|recurring|regress|risk|pipeline/.test(q) || (k === 'flaky' && /flaky/.test(q)) || (k === 'skip' && /skip/.test(q)) || (k === 'repeat' && /repeat|recurring/.test(q)) || (k === 'pipeline' && /pipeline/.test(q)) || /risk|regress/.test(q);
    const parts = [];
    if (want('flaky')) {
      parts.push(`${ins.flaky.length} flaky`);
      a.sections.push({ title: 'Possibly flaky tests', items: ins.flaky.map((f) => ({ kind: 'insight', title: f.title, subtitle: f.file, badges: [{ text: f.confidence, tone: f.confidence === 'confirmed' ? 'bad' : 'warn' }], lines: [f.why], links: (f.runs || []).slice(0, 3).map((r) => ({ label: `Run ${r.runId}`, url: r.url })), evidence: f.confidence })) });
    }
    if (want('repeat')) {
      parts.push(`${ins.repeatedFailures.length} repeatedly failing`);
      a.sections.push({ title: 'Repeated failures', items: ins.repeatedFailures.map((f) => ({ kind: 'insight', title: f.title, subtitle: f.file, badges: [{ text: `${f.count}/${f.window} runs`, tone: 'bad' }], lines: [f.why, ...f.runs.map((r) => `${when(r.at)} · ${r.outcome}${r.error ? ` — ${r.error}` : ''}`)], links: f.runs.slice(0, 3).map((r) => ({ label: `Run ${r.runId}`, url: r.url })), evidence: 'confirmed' })) });
    }
    if (want('skip')) {
      parts.push(`${ins.consistentlySkipped.length} consistently skipped`);
      a.sections.push({ title: 'Consistently skipped tests', items: ins.consistentlySkipped.map((s) => ({ kind: 'insight', title: s.title, subtitle: s.file, lines: [s.why], evidence: 'confirmed' })) });
    }
    if (want('pipeline')) {
      parts.push(`${ins.pipelineFailures.length} pipeline failures`);
      a.sections.push({ title: 'Pipeline failures (tests never ran)', items: ins.pipelineFailures.map((p) => ({ kind: 'insight', title: p.label, subtitle: `${p.stage || ''}${p.step ? ` — step "${p.step.name}"` : ''}`, when: when(p.at), lines: [`Run ${p.runId} @ ${shortSha(p.sha)}`], links: [{ label: 'Run', url: p.url }], evidence: 'confirmed' })) });
    }
    if (/risk|regress/.test(q) || !/flaky|skip|repeat|recurring|pipeline/.test(q)) {
      parts.push(`${ins.coverageGaps.length} coverage gaps`, `${ins.newFailures.length} pass→fail transitions`, `${ins.neverExecutedTests.length} never-executed tests`);
      a.sections.push({ title: 'New failures and associated changes', items: ins.newFailures.slice(-10).reverse().map((f) => ({ kind: 'insight', title: f.title, subtitle: `failed ${when(f.run.at)} (run ${f.run.runId})`, lines: [f.why, ...((f.candidateCommits || []).filter((c) => c.links.length).slice(0, 3).map((c) => `${c.shortSha}: ${c.links.map((l) => l.text).join('; ')}`))], links: [{ label: 'Failing run', url: f.run.url }, { label: 'Last passing run', url: f.lastPass.url }], evidence: 'correlation' })) });
      a.sections.push({ title: 'Tests never executed in CI', items: ins.neverExecutedTests.map((t) => ({ kind: 'insight', title: t.title, subtitle: t.file, lines: [`Present since ${t.since.at ? when(t.since.at) : 'before recorded history'}; no recorded run has a result for it.`], evidence: 'confirmed' })) });
      const changeById = new Map(index.codeChanges.map((c) => [c.id, c]));
      a.sections.push({ title: 'Regression coverage gaps', items: ins.coverageGaps.slice(0, 30).map((g) => codeChangeItem(changeById.get(g.changeId))).filter(Boolean) });
    }
    a.headline = `Risk overview: ${parts.join(', ')}.`;
    if (!index.totals.runsWithResults) a.missing.push('No runs with captured test results yet: flaky, skipped and failure insights need test results.');
    a.notes.push('Flaky "confirmed" means Playwright reported a pass on retry; "possible" means mixed results on the same commit. Neither proves the root cause.');
    return a;
  }

  function answerTestHistory(index, ctx) {
    const a = base(ctx.question, 'test-history', 'Test case history', null);
    const t = findTest(index, ctx.q);
    if (!t) {
      a.headline = 'Could not identify which test you mean.';
      a.missing.push('Put the test title in quotes, e.g. history of "Add products with quantities from Excel to cart @1".');
      return a;
    }
    const changes = index.testChanges.filter((c) => c.testId === t.testId);
    const results = index.runs.filter((r) => r.tests.available).map((r) => ({ r, res: r.tests.results.find((x) => x.testId === t.testId) })).filter((x) => x.res);
    a.headline = `"${t.title}" (${t.status}) — ${plural(changes.length, 'recorded change')}, ${plural(results.length, 'recorded execution')}${t.lastResult ? `; last result: ${t.lastResult.outcome} (${when(t.lastResult.at)})` : ''}.`;
    a.points.push(`Stable id ${t.testId}; file ${t.file}${t.keys.length > 1 ? `; previous names: ${t.keys.slice(0, -1).map((k) => k.split('::')[1]).join(' | ')}` : ''}.`);
    if (t.runCount) a.points.push(`Pass rate ${pct(t.passCount, t.runCount)} over ${t.runCount} recorded execution(s).`);
    a.sections.push({ title: 'Changes', items: changes.map(testChangeItem) });
    a.sections.push({ title: 'Executions', items: results.slice(0, 30).map(({ r, res }) => ({ kind: 'test-result', title: `${runName(r)} — ${res.outcome}`, subtitle: `${r.branch} @ ${shortSha(r.sha)}`, when: when(r.completedAt), badges: [{ text: res.outcome, tone: PASS.includes(res.outcome) ? 'good' : FAIL.includes(res.outcome) ? 'bad' : 'muted' }], lines: res.error && res.error.summary ? [res.error.summary] : [], links: [{ label: 'Run', url: r.link }], evidence: 'confirmed' })) });
    return a;
  }

  function answerSearch(index, ctx) {
    const a = base(ctx.question, 'search', 'Search', ctx.range);
    const words = tokens(ctx.q).filter((w) => !STOP.has(w) && w.length > 2);
    const match = (s) => words.length && words.every((w) => String(s).toLowerCase().includes(w));
    const tc = index.testChanges.filter((c) => inRange(c.at, ctx.range) && match(`${c.title} ${c.file} ${c.previousTitle || ''}`));
    const cc = index.codeChanges.filter((c) => inRange(c.at, ctx.range) && match(`${c.qualifiedName} ${c.file}`));
    const cf = index.configChanges.filter((c) => inRange(c.at, ctx.range) && match(`${c.file} ${(c.summary || []).join(' ')}`));
    const commits = Object.values(index.commits).filter((c) => inRange(c.committedAt, ctx.range) && match(`${c.subject} ${c.author}`));
    const total = tc.length + cc.length + cf.length + commits.length;
    a.headline = total ? `${plural(total, 'record')} match "${words.join(' ')}"${ctx.range ? ` ${rangeLabel(ctx.range)}` : ''}.` : "I couldn't match that question to a query or any recorded activity.";
    if (!total) {
      a.points.push('Try questions like: "What tests were added this week?", "What methods were modified yesterday?", "What happened in the latest scheduled run?", "What tests failed in the last 5 runs?", "Which commit introduced this failure?", "Which changed methods have not been covered?", "Show QA activity for commit abc1234", "Summarize this week", "Compare the latest scheduled run with the previous one", "Which tests are flaky?".');
    }
    a.sections.push({ title: 'Commits', items: commits.map((c) => ({ kind: 'commit', title: `${c.shortSha} ${c.subject}`, subtitle: c.author, when: when(c.committedAt), lines: [`${c.counts.testChanges || 0} test change(s), ${c.counts.codeChanges || 0} code change(s), ${c.counts.configChanges || 0} config change(s)`], links: [{ label: 'Commit', url: c.url }], evidence: 'confirmed' })) });
    a.sections.push({ title: 'Test changes', items: tc.map(testChangeItem) });
    a.sections.push({ title: 'Code changes', items: cc.map(codeChangeItem) });
    a.sections.push({ title: 'Config changes', items: cf.map(configChangeItem) });
    return a;
  }

  // ── Router ────────────────────────────────────────────────────────────────
  function interpret(question, now) {
    const q = ` ${String(question || '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
    const dr = T.resolveDateRange(q, now);
    const ctx = { question: String(question || '').trim(), q, now, range: dr ? dr.range : null, event: detectEvent(q), count: detectCount(q, null), sha: detectSha(q), branch: detectBranch(q), author: detectAuthor(q) };
    const isTests = /\btests?\b|test ?cases?|\bspecs?\b|scenarios?/.test(q);
    const isRuns = /\bruns?\b|executions?|\bbuilds?\b|pipelines?|workflows? runs?|\bci\b/.test(q);
    let intent;
    if (ctx.sha && /commit|sha|activit|show|what|happen/.test(q)) intent = 'commit';
    else if (/\bcompare|comparison|\bvs\.?\b|versus|differen/.test(q) && (isRuns || ctx.event)) intent = 'compare-runs';
    else if (/(which|what) commits? (introduced|caused|broke)|introduced (this|the|a)? ?(failure|regression|bug)|root cause|caused (this|the) failure|why did .* fail|started failing|broke the/.test(q)) intent = 'failure-origin';
    else if (/not (been )?(covered|tested|exercised|verified)|uncovered|coverage gaps?|without (a )?(successful|passing)|untested|not covered/.test(q)) intent = 'coverage-gaps';
    else if (/flaky|consistently skipped|skipped tests?|always skipped|recurring|repeated(ly)? fail|risks?\b|regression gaps?|pipeline failures?|quality insights?/.test(q)) intent = 'insights';
    else if (/(fail|failing|failed|failures?|broken)/.test(q) && (isRuns || /last \S+ (runs?|executions?)/.test(q) || isTests) && !/(added|deleted|removed|renamed)/.test(q)) intent = 'recent-failures';
    else if (/(latest|last|most recent|previous|recent) (\w+ ){0,2}(run|execution|build|pipeline)\b|what happened in the (latest|last)/.test(q) && !ctx.count) intent = 'run-detail';
    else if (/summar|progress|overview|recap|how (did|are) we doing|status report/.test(q)) intent = 'summary';
    else if (/history of|tell me about (the )?test|test history|lifecycle of/.test(q)) intent = 'test-history';
    else if (/methods?|functions?|class(es)?|page ?objects?|helpers?|utilit|fixtures?|framework|locators?|config|dependenc|package|workflow file|reporter|excel|test.?data|code changes?/.test(q) && !/test ?cases?/.test(q)) intent = 'code-changes';
    else if (isTests && /(add|added|new|creat|modif|chang|updat|delet|remov|renam|mov|introduc)/.test(q)) intent = 'test-changes';
    else if (isRuns || ctx.event) intent = 'runs';
    else if (/what happened|activit|changes?/.test(q) && ctx.range) intent = 'summary';
    else intent = 'search';
    return { intent, ctx };
  }

  const HANDLERS = {
    commit: answerCommit,
    'compare-runs': answerCompare,
    'failure-origin': answerFailureOrigin,
    'coverage-gaps': answerCoverageGaps,
    insights: answerInsights,
    'recent-failures': answerFailuresRecent,
    'run-detail': answerRunDetail,
    summary: answerSummary,
    'test-history': answerTestHistory,
    'code-changes': answerCodeChanges,
    'test-changes': answerTestChanges,
    runs: answerRunsList,
    search: answerSearch,
  };

  /**
   * Answers a question against the index.
   * @param {object} index  output of buildIndex
   * @param {string} question
   * @param {{now?: Date|string}} options  `now` anchors relative dates (default: current time)
   */
  function ask(index, question, options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    REPO = index.repo || null;
    TESTS = index.tests || {};
    const { intent, ctx } = interpret(question, now);
    const answer = HANDLERS[intent](index, ctx);
    answer.sections = answer.sections.filter((s) => s.items && s.items.length);
    if (answer.range) answer.rangeText = `Date range used: ${answer.range.description} (${answer.range.timezone}).`;
    answer.interpretation = { intent, event: ctx.event, count: ctx.count, sha: ctx.sha, branch: ctx.branch, author: ctx.author };
    answer.dataAsOf = index.builtAt;
    if (ctx.branch || ctx.author) answer.notes.push(`Filtered by${ctx.branch ? ` branch "${ctx.branch}"` : ''}${ctx.author ? ` author "${ctx.author}"` : ''}.`);
    return answer;
  }

  /** Plain-text rendering for terminals and step summaries. */
  function renderText(answer, { maxItems = 15, markdown = false } = {}) {
    const out = [];
    const b = (s) => (markdown ? `**${s}**` : s);
    out.push(b(answer.headline));
    if (answer.rangeText) out.push(answer.rangeText);
    answer.points.forEach((p) => out.push(`  • ${p}`));
    for (const s of answer.sections) {
      out.push('', markdown ? `### ${s.title}` : `── ${s.title} ──`);
      for (const it of s.items.slice(0, maxItems)) {
        const badges = (it.badges || []).map((x) => `[${x.text}]`).join(' ');
        out.push(`${markdown ? '- ' : '  ▸ '}${it.title}${badges ? `  ${badges}` : ''}`);
        if (it.subtitle) out.push(`      ${it.subtitle}`);
        if (it.when || it.meta) out.push(`      ${[it.when, it.meta].filter(Boolean).join(' · ')}`);
        (it.lines || []).slice(0, 8).forEach((l) => out.push(`      - ${l}`));
        (it.links || []).slice(0, 4).forEach((l) => out.push(`      ↗ ${l.label}: ${l.url}`));
      }
      if (s.items.length > maxItems) out.push(`  …${s.items.length - maxItems} more (use --json or the dashboard for everything)`);
    }
    if (answer.missing.length) {
      out.push('', markdown ? '### What is missing or unverified' : '── What is missing or unverified ──');
      answer.missing.forEach((m) => out.push(`  ! ${m}`));
    }
    if (answer.notes.length) {
      out.push('', markdown ? '### Notes' : '── Notes ──');
      answer.notes.forEach((m) => out.push(`  i ${m}`));
    }
    out.push('', `Data as of ${T.formatIst(answer.dataAsOf)}.`);
    return out.join('\n');
  }

  /** Lets the dashboard build list items with the same wording as answers. */
  function useIndex(index) {
    REPO = index.repo || null;
    TESTS = index.tests || {};
    return { testChangeItem, codeChangeItem, configChangeItem, runItem };
  }

  return { ask, interpret, renderText, useIndex, STATUS_TEXT, EVENT_LABELS };
});

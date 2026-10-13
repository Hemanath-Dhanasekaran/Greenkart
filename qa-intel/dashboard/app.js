/* QA Intelligence dashboard — renders window.QA_INDEX with QAQuery / QATime. */
(function () {
  'use strict';

  const I = window.QA_INDEX;
  const T = window.QATime;
  const Q = window.QAQuery;
  const B = Q.useIndex(I);
  const NOW = new Date();
  const PAGE = 25;

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const badge = (b) => h('span', { class: `badge ${b.tone || ''}` }, b.text);
  const safeUrl = (u) => (/^https:\/\//.test(u || '') ? u : null);

  function renderItem(item) {
    if (!item) return null;
    const d = h('details', { class: 'item' });
    d.append(h('summary', null,
      h('div', { class: 'head' }, h('span', { class: 't' }, item.title), (item.badges || []).map(badge), item.when ? h('span', { class: 'when' }, item.when) : null),
      item.subtitle ? h('div', { class: 'subtitle' }, item.subtitle) : null,
      item.lines && item.lines[0] ? h('div', { class: 'small muted' }, item.lines[0]) : null));
    const body = h('div', { class: 'body' });
    if (item.meta) body.append(h('div', { class: 'small muted' }, item.meta));
    if (item.lines && item.lines.length) body.append(h('ul', null, item.lines.map((l) => h('li', null, l))));
    const links = (item.links || []).filter((l) => safeUrl(l.url));
    if (links.length) body.append(h('div', { class: 'links' }, links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener', class: l.expired ? 'expired' : null, title: l.expired ? 'Artifact has expired' : null }, `↗ ${l.label}`))));
    if (item.evidence) body.append(h('div', { class: 'small muted' }, `Evidence: ${item.evidence}`));
    if (item.details) {
      const tech = h('details', { class: 'tech-wrap' }, h('summary', null, 'Technical details'));
      tech.addEventListener('toggle', () => {
        if (tech.open && !tech.querySelector('pre')) tech.append(h('pre', { class: 'tech' }, JSON.stringify(item.details, null, 2)));
      }, { once: false });
      body.append(tech);
    }
    d.append(body);
    return d;
  }

  function renderList(items, emptyText) {
    if (!items.length) return h('div', { class: 'empty' }, emptyText || 'Nothing recorded for this selection.');
    const wrap = h('div', { class: 'stack' });
    let shown = 0;
    const more = h('button', { class: 'reset', onclick: () => page() }, '');
    function page() {
      items.slice(shown, shown + PAGE).forEach((it) => wrap.insertBefore(renderItem(it), more));
      shown = Math.min(items.length, shown + PAGE);
      more.textContent = `Show more (${items.length - shown} remaining)`;
      more.style.display = shown < items.length ? '' : 'none';
    }
    wrap.append(more);
    page();
    return wrap;
  }

  function renderAnswer(a) {
    const box = h('div', { class: 'stack' });
    box.append(h('div', { class: 'card' },
      h('p', { class: 'conclusion' }, a.headline),
      a.rangeText ? h('div', { class: 'small muted' }, a.rangeText) : null,
      a.points.length ? h('ul', { class: 'answer-points' }, a.points.map((p) => h('li', null, p))) : null,
      h('div', { class: 'small muted', style: 'margin-top:6px' }, `Interpreted as: ${a.intentLabel} · data as of ${T.formatIst(a.dataAsOf)}`)));
    a.missing.forEach((m) => box.append(h('div', { class: 'notice' }, m)));
    for (const s of a.sections) box.append(h('h3', null, `${s.title} (${s.items.length})`), renderList(s.items));
    a.notes.forEach((n) => box.append(h('div', { class: 'notice info' }, n)));
    return box;
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  const F = { from: '', to: '', branch: '', author: '', file: '', type: '', text: '' };
  const allBranches = [...new Set([...I.runs.map((r) => r.branch), ...Object.values(I.commits).map((c) => c.branch)].filter(Boolean))].sort();
  const allAuthors = [...new Set(Object.values(I.commits).map((c) => c.author).filter(Boolean))].sort();
  const allSpecFiles = [...new Set(Object.values(I.tests).map((t) => t.file))].sort();

  function passes(x, { at, branch, author, file, type, text }) {
    if (F.from && Date.parse(at) < T.istMidnight(...F.from.split('-').map(Number)).getTime()) return false;
    if (F.to && Date.parse(at) >= T.istMidnight(...F.to.split('-').map(Number)).getTime() + 86400000) return false;
    if (F.branch && branch !== F.branch) return false;
    if (F.author && author !== F.author) return false;
    if (F.file && !(file || []).includes(F.file)) return false;
    if (F.type && type !== F.type) return false;
    if (F.text && !String(text).toLowerCase().includes(F.text.toLowerCase())) return false;
    return true;
  }

  function filterBar(types, onChange) {
    const sel = (key, label, options) => h('label', null, label, h('select', { onchange: (e) => { F[key] = e.target.value; onChange(); } },
      h('option', { value: '' }, 'All'), options.map((o) => h('option', { value: o.value ?? o, selected: F[key] === (o.value ?? o) ? true : null }, o.label ?? o))));
    return h('div', { class: 'filters' },
      h('label', null, 'From (IST)', h('input', { type: 'date', value: F.from, onchange: (e) => { F.from = e.target.value; onChange(); } })),
      h('label', null, 'To (IST)', h('input', { type: 'date', value: F.to, onchange: (e) => { F.to = e.target.value; onChange(); } })),
      sel('branch', 'Branch', allBranches),
      sel('author', 'Author', allAuthors),
      sel('file', 'Test file', allSpecFiles),
      types ? sel('type', 'Activity type', types) : null,
      h('label', null, 'Search', h('input', { type: 'search', value: F.text, placeholder: 'title, method, file…', oninput: (e) => { F.text = e.target.value; onChange(); } })),
      h('button', { class: 'reset', onclick: () => { Object.keys(F).forEach((k) => (F[k] = '')); onChange(true); } }, 'Reset'));
  }

  function filteredPanel(panel, types, build) {
    const results = h('div');
    const redraw = (rebuildBar) => {
      if (rebuildBar) panel.replaceChildren(filterBar(types, redraw), results);
      results.replaceChildren(build());
    };
    panel.replaceChildren(filterBar(types, redraw), results);
    redraw();
  }

  // ── Activity accessors ────────────────────────────────────────────────────
  const commitFiles = (sha) => ((I.commits[sha] || {}).files || []).map((f) => f.path);
  const testChangeFilter = (c) => passes(c, { at: c.at, branch: c.branch, author: c.author, file: [c.file, c.previousFile], type: `test ${c.type}`, text: `${c.title} ${c.file} ${c.previousTitle || ''}` });
  const codeChangeFilter = (c) => passes(c, { at: c.at, branch: c.branch, author: c.author, file: commitFiles(c.sha), type: `code ${c.type}`, text: `${c.qualifiedName} ${c.file}` });
  const configChangeFilter = (c) => passes(c, { at: c.at, branch: c.branch, author: c.author, file: commitFiles(c.sha), type: 'config changed', text: `${c.file} ${(c.summary || []).join(' ')}` });
  const runFilter = (r) => passes(r, { at: r.completedAt, branch: r.branch, author: r.commitAuthor, file: (r.tests.results || []).map((t) => t.file), type: `run ${r.event}`, text: `${r.workflow.name} ${r.title} ${r.classification.label} ${(r.tests.results || []).map((t) => t.title).join(' ')}` });

  // ── Panels ────────────────────────────────────────────────────────────────
  function kpi(label, value, hint) {
    return h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);
  }

  function overview(panel) {
    const week = T.lastNDays(NOW, 7, 'last 7 days');
    const inWeek = (at) => T.inRange(at, week);
    const latest = I.runs[0];
    const latestTone = latest ? B.runItem(latest).badges[0] : null;
    const gaps = I.insights.coverageGaps.length;
    panel.append(
      h('div', { class: 'kpis' },
        kpi('Active tests', I.totals.activeTests, `${I.totals.deletedTests} deleted over time`),
        kpi('Tests added (7 days)', I.testChanges.filter((c) => c.type === 'added' && inWeek(c.at)).length, week.description),
        kpi('Code changes (7 days)', I.codeChanges.filter((c) => inWeek(c.at) && !(c.kind === 'class' && c.type === 'modified')).length, 'methods, classes, fixtures'),
        kpi('CI runs (7 days)', I.runs.filter((r) => inWeek(r.completedAt)).length, `${I.totals.runs} recorded in total`),
        kpi('Latest run', latest ? h('span', null, badge(latestTone)) : '—', latest ? T.formatIst(latest.completedAt) : 'no runs recorded'),
        kpi('Coverage gaps', gaps, 'changed methods not yet confirmed')),
      h('h2', null, 'Key conclusions'));
    const conclusions = [
      ['This week', Q.ask(I, 'summarize this week', { now: NOW })],
      ['Latest run', Q.ask(I, 'what happened in the latest run', { now: NOW })],
      ['Latest scheduled run', Q.ask(I, 'what happened in the latest scheduled run', { now: NOW })],
      ['Coverage', Q.ask(I, 'which changed methods have not been covered by a successful relevant test run', { now: NOW })],
    ];
    panel.append(h('div', { class: 'grid2' }, conclusions.map(([label, a]) => h('div', { class: 'card' },
      h('div', { class: 'small muted' }, label),
      h('p', { class: 'conclusion' }, a.headline),
      a.points.length ? h('ul', { class: 'answer-points small' }, a.points.slice(0, 4).map((p) => h('li', null, p))) : null,
      a.missing.slice(0, 2).map((m) => h('div', { class: 'small', style: 'color:var(--tone-warn-ink);margin-top:4px' }, `! ${m}`))))));
    if (I.dataQuality.length) {
      panel.append(h('h2', null, 'Data completeness'), h('div', { class: 'stack' }, I.dataQuality.map((d) => h('div', { class: 'notice' }, d.text))));
    }
    panel.append(h('h2', null, 'Most recent activity'), renderList(timelineItems().slice(0, 8)));
  }

  function commitItem(c) {
    const tc = I.testChanges.filter((x) => x.sha === c.sha);
    const cc = I.codeChanges.filter((x) => x.sha === c.sha && !(x.kind === 'class' && x.type === 'modified'));
    const cf = I.configChanges.filter((x) => x.sha === c.sha);
    const lines = [
      ...tc.map((x) => `Test ${x.type}: ${x.title}`),
      ...cc.slice(0, 12).map((x) => `${x.kind} ${x.type}: ${x.qualifiedName}`),
      ...(cc.length > 12 ? [`…and ${cc.length - 12} more code change(s)`] : []),
      ...cf.map((x) => `${x.categoryLabel}: ${(x.summary || []).slice(0, 2).join('; ')}`),
      ...(c.files || []).filter((f) => f.note).map((f) => `${f.path}: ${f.note}`),
    ];
    return {
      title: `${c.shortSha} ${c.subject}`,
      subtitle: `${c.author || 'unknown'}${c.authorLogin ? ` (@${c.authorLogin})` : ''} · ${c.branch || ''} · ${(c.files || []).length} file(s)`,
      when: T.formatIst(c.committedAt),
      badges: [{ text: 'commit', tone: 'muted' }, tc.length ? { text: `${tc.length} test change(s)`, tone: 'info' } : null, cc.length ? { text: `${cc.length} code change(s)`, tone: 'info' } : null, cf.length ? { text: `${cf.length} config/data`, tone: 'info' } : null].filter(Boolean),
      lines: lines.length ? lines : ['No test, code or configuration changes detected.'],
      links: [{ label: 'Commit', url: c.url }, ...((c.pullRequests || []).map((p) => ({ label: `PR #${p.number}`, url: p.url })))],
      evidence: 'confirmed',
      details: { sha: c.sha, parents: c.parents, files: c.files, counts: c.counts },
    };
  }

  function timelineItems(filterFn) {
    const out = [];
    for (const c of Object.values(I.commits)) {
      if (c.baseline) continue;
      if (filterFn && !filterFn({ kind: 'commit', c })) continue;
      out.push({ at: c.committedAt, item: commitItem(c) });
    }
    for (const r of I.runs) {
      if (filterFn && !filterFn({ kind: 'run', r })) continue;
      out.push({ at: r.completedAt, item: B.runItem(r) });
    }
    return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((x) => x.item);
  }

  function timeline(panel) {
    const keep = (x) => (x.kind === 'commit'
      ? passes(x.c, { at: x.c.committedAt, branch: x.c.branch, author: x.c.author, file: commitFiles(x.c.sha), type: 'commit', text: `${x.c.subject} ${x.c.sha}` })
      : runFilter(x.r));
    filteredPanel(panel, ['commit', 'run push', 'run schedule', 'run workflow_dispatch', 'run pull_request'], () => renderList(timelineItems(keep), 'No activity matches these filters.'));
  }

  function testHistoryItem(t) {
    const res = t.lastResult;
    return {
      title: t.title,
      subtitle: `${t.file}${t.status === 'deleted' ? ' · deleted' : ''}`,
      when: t.lastChange ? `changed ${T.formatIst(t.lastChange.at)}` : '',
      badges: [
        { text: t.status, tone: t.status === 'active' ? 'muted' : 'bad' },
        res ? { text: `last: ${res.outcome}`, tone: res.outcome === 'passed' ? 'good' : res.outcome === 'flaky' ? 'warn' : /failed|timedOut|interrupted/.test(res.outcome) ? 'bad' : 'muted' } : { text: 'never executed', tone: 'warn' },
        t.runCount ? { text: `${t.passCount}/${t.runCount} passed`, tone: 'muted' } : null,
      ].filter(Boolean),
      lines: [
        `Stable id ${t.testId}${t.firstSeen && t.firstSeen.at ? ` · first seen ${T.formatIst(t.firstSeen.at)} (${(t.firstSeen.sha || 'baseline').slice(0, 7)})` : ''}`,
        ...(t.keys.length > 1 ? [`Earlier names: ${t.keys.slice(0, -1).map((k) => k.split('::')[1]).join(' | ')}`] : []),
        ...(res && res.error ? [`Last error: ${res.error}`] : []),
        `${t.changes.length} recorded change(s)`,
      ],
      links: [res ? { label: 'Last run', url: res.url } : null].filter(Boolean),
      details: { testId: t.testId, key: t.key, keys: t.keys, tags: t.tags, firstSeen: t.firstSeen, lastChange: t.lastChange, lastResult: res },
    };
  }

  function testsPanel(panel) {
    filteredPanel(panel, ['test added', 'test modified', 'test renamed', 'test moved', 'test deleted'], () => {
      const changes = I.testChanges.filter(testChangeFilter);
      const tests = Object.values(I.tests).filter((t) => (!F.file || t.file === F.file) && (!F.text || `${t.title} ${t.file}`.toLowerCase().includes(F.text.toLowerCase())))
        .sort((a, b) => (a.status === b.status ? a.title.localeCompare(b.title) : a.status === 'active' ? -1 : 1));
      return h('div', null,
        h('h2', null, `Test case changes (${changes.length})`),
        renderList(changes.map(B.testChangeItem), 'No test case changes match these filters.'),
        h('h2', null, `All test cases (${tests.length})`),
        h('p', { class: 'small muted' }, 'Each test keeps a stable id across renames and moves. Expand a test for its history.'),
        renderList(tests.map(testHistoryItem)));
    });
  }

  function frameworkPanel(panel) {
    filteredPanel(panel, ['code added', 'code modified', 'code renamed', 'code deleted', 'config changed'], () => {
      const code = I.codeChanges.filter(codeChangeFilter).filter((c) => !(c.kind === 'class' && c.type === 'modified' && c.coverage.status === 'not-applicable'));
      const cfg = I.configChanges.filter(configChangeFilter);
      return h('div', null,
        h('h2', null, `Methods, classes, page objects and fixtures (${code.length})`),
        renderList(code.map(B.codeChangeItem), 'No code changes match these filters.'),
        h('h2', null, `Configuration, dependencies, workflows and test data (${cfg.length})`),
        renderList(cfg.map(B.configChangeItem), 'No configuration changes match these filters.'));
    });
  }

  function runsPanel(panel) {
    filteredPanel(panel, ['run push', 'run schedule', 'run workflow_dispatch', 'run pull_request'], () => {
      const runs = I.runs.filter(runFilter);
      const missing = runs.filter((r) => !r.tests.available).length;
      return h('div', null,
        missing ? h('div', { class: 'notice', style: 'margin-bottom:10px' }, `${missing} of these runs have no captured test results — their pass/fail counts are unknown, not zero.`) : null,
        renderList(runs.map(B.runItem), 'No runs match these filters.'));
    });
  }

  function risksPanel(panel) {
    panel.append(renderAnswer(Q.ask(I, 'show qa risks and regression gaps', { now: NOW })));
  }

  function tracePanel(panel) {
    const commits = I.commitOrder.slice().reverse().map((s) => I.commits[s]).filter((c) => !c.baseline);
    const out = h('div');
    const select = h('select', { onchange: (e) => out.replaceChildren(renderAnswer(Q.ask(I, `show all qa activity for commit ${e.target.value}`, { now: NOW }))) },
      commits.map((c) => h('option', { value: c.sha }, `${c.shortSha} — ${c.subject} (${T.formatIst(c.committedAt, { withTime: false })})`)));
    panel.append(
      h('p', { class: 'small muted' }, 'Commit → changed methods and files → affected tests (static call graph) → runs that tested a commit containing the change → results and reports.'),
      h('div', { class: 'filters' }, h('label', { style: 'flex:1' }, 'Commit', select)), out);
    if (commits.length) out.append(renderAnswer(Q.ask(I, `show all qa activity for commit ${commits[0].sha}`, { now: NOW })));
    else out.append(h('div', { class: 'empty' }, 'No commits recorded yet.'));

    // Coverage matrix: latest change per method → linked tests → confirming run
    const latest = new Map();
    for (const c of I.codeChanges) if (c.type !== 'deleted' && c.coverage.status !== 'not-applicable' && !latest.has(c.symbolId)) latest.set(c.symbolId, c);
    const rows = [...latest.values()];
    panel.append(h('h2', null, `Method → test → run traceability (${rows.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Method', 'Last change', 'Linked tests', 'Coverage', 'Evidence run'].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((c) => h('tr', null,
          h('td', null, h('a', { href: safeUrl(c.links && c.links.file), target: '_blank', rel: 'noopener' }, c.qualifiedName), h('div', { class: 'small muted' }, c.file)),
          h('td', null, `${c.type} · ${c.shortSha}`, h('div', { class: 'small muted' }, T.formatIst(c.at))),
          h('td', null, c.impact.scope === 'global' ? 'all tests (runner-level)' : c.impact.tests.length ? c.impact.tests.map((t) => h('div', { class: 'small' }, t.testKey.split(' > ').pop())) : h('span', { class: 'muted' }, 'none')),
          h('td', null, badge({ text: c.coverage.status, tone: { verified: 'good', executed: 'good', failing: 'bad', 'not-executed': 'warn', 'no-linked-tests': 'warn' }[c.coverage.status] || 'muted' }), h('div', { class: 'small muted' }, c.coverage.reason)),
          h('td', null, c.coverage.run ? h('a', { href: safeUrl(c.coverage.run.url), target: '_blank', rel: 'noopener' }, `run ${c.coverage.run.runId}`) : '—')))))));
  }

  function askPanel(panel) {
    const out = h('div');
    const input = h('input', { type: 'text', placeholder: 'Ask about tests, methods, runs, failures… (dates in IST)', 'aria-label': 'Question' });
    const go = (q) => {
      if (q !== undefined) input.value = q;
      if (!input.value.trim()) return;
      out.replaceChildren(renderAnswer(Q.ask(I, input.value, { now: new Date() })));
      try { localStorage.setItem('qa-intel-last-question', input.value); } catch (e) { /* storage unavailable */ }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    const examples = ['What test cases were added two days ago?', 'What tests were added this week?', 'What methods were added or modified yesterday?', 'What framework changes happened in the last seven days?', 'What test cases were deleted this month?', 'What happened in the latest scheduled run?', 'What tests failed in the last five executions?', 'Which commit introduced this failure?', 'Which changed methods have not been covered by a successful relevant test run?', 'Summarize this week\'s automation progress', 'Compare the latest scheduled run with the previous scheduled run', 'Which tests are flaky?'];
    panel.append(
      h('div', { class: 'ask-box' }, input, h('button', { onclick: () => go() }, 'Ask')),
      h('div', { class: 'chips' }, examples.map((q) => h('button', { onclick: () => go(q) }, q))),
      h('p', { class: 'small muted' }, 'Answers are computed from recorded history only (no AI service). Relative dates use Asia/Kolkata time and the exact range is shown with each answer.'),
      out);
    let last = '';
    try { last = localStorage.getItem('qa-intel-last-question') || ''; } catch (e) { /* ignore */ }
    go(last || examples[1]);
  }

  // ── Trends (SVG charts) ───────────────────────────────────────────────────
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }
  function topRounded(x, y, w, hgt, r) {
    const rr = Math.min(r, w / 2, hgt);
    return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
  }

  function stackedBars(card, days, series, valueOf, fmtTip) {
    const W = 800;
    const H = 220;
    const pad = { l: 34, r: 8, t: 10, b: 24 };
    const max = Math.max(1, ...days.map((d) => series.reduce((sum, se) => sum + valueOf(d, se), 0)));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
    for (const t of ticks) {
      svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }));
      const lbl = s('text', { class: 'axis', x: pad.l - 6, y: y(t) + 3.5, 'text-anchor': 'end' });
      lbl.textContent = t;
      svg.append(lbl);
    }
    const slot = (W - pad.l - pad.r) / days.length;
    const bw = Math.max(3, Math.min(22, slot * 0.62));
    const tip = card.querySelector('.tooltip');
    days.forEach((d, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      let acc = 0;
      const segs = series.map((se) => ({ se, v: valueOf(d, se) })).filter((p) => p.v > 0);
      segs.forEach((p, k) => {
        const y0 = y(acc);
        const y1 = y(acc + p.v);
        // segments above the first leave a 2px surface gap to the one below
        const hgt = Math.max(1, y0 - y1 - (k > 0 ? 2 : 0));
        if (k === segs.length - 1) svg.append(s('path', { d: topRounded(x, y1, bw, hgt, 4), fill: `var(${p.se.color})` }));
        else svg.append(s('rect', { x, y: y1, width: bw, height: hgt, fill: `var(${p.se.color})` }));
        acc += p.v;
      });
      const every = Math.ceil(days.length / 8);
      // label every Nth day plus the last one, skipping a regular label that would collide with it
      if ((i % every === 0 && days.length - 1 - i >= every / 2) || i === days.length - 1) {
        const lbl = s('text', { class: 'axis', x: pad.l + slot * i + slot / 2, y: H - 6, 'text-anchor': 'middle' });
        lbl.textContent = d.date.slice(5);
        svg.append(lbl);
      }
      const hit = s('rect', { class: 'hit', x: pad.l + slot * i, y: pad.t, width: slot, height: H - pad.t - pad.b });
      hit.addEventListener('mousemove', (e) => {
        tip.replaceChildren(h('b', null, T.formatIst(T.istMidnight(...d.date.split('-').map(Number)), { withTime: false })), ...fmtTip(d));
        const box = card.getBoundingClientRect();
        tip.style.display = 'block';
        const left = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 8);
        tip.style.left = `${Math.max(8, left)}px`;
        tip.style.top = `${e.clientY - box.top + 12}px`;
      });
      hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      svg.append(hit);
    });
    return svg;
  }

  function niceTicks(max) {
    const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
    const out = [];
    for (let v = 0; v <= max + step - 1 && out.length < 8; v += step) out.push(v);
    if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
    return out;
  }

  function chartCard(title, subtitle, series, days, valueOf, tableCols) {
    const card = h('div', { class: 'chart-card' });
    let tableView = false;
    const body = h('div');
    const toggle = h('button', { class: 'view-toggle', onclick: () => { tableView = !tableView; draw(); } }, 'Table view');
    const draw = () => {
      toggle.textContent = tableView ? 'Chart view' : 'Table view';
      if (tableView) {
        body.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'Date (IST)'), tableCols.map((c) => h('th', { class: 'num' }, c.label)))),
          h('tbody', null, days.slice().reverse().map((d) => h('tr', null, h('td', null, d.date), tableCols.map((c) => h('td', { class: 'num' }, c.value(d)))))))));
      } else {
        body.replaceChildren(stackedBars(card, days, series, valueOf, (d) => series.map((se) => h('div', null, h('i', { style: `background:var(${se.color})` }), `${se.label}: ${valueOf(d, se)}`))));
      }
    };
    // A single series needs no legend: the title names it.
    const legend = series.length > 1 ? h('div', { class: 'legend' }, series.map((se) => h('span', null, h('i', { style: `background:var(${se.color})` }), se.label))) : null;
    card.append(...[toggle, h('h3', null, title), h('div', { class: 'small muted' }, subtitle), legend, body, h('div', { class: 'tooltip', role: 'status' })].filter(Boolean));
    draw();
    return card;
  }

  function trendsPanel(panel) {
    const byDate = new Map(I.daily.map((d) => [d.date, d]));
    const end = T.istParts(NOW);
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const key = T.istDateKey(T.istMidnight(end.year, end.month, end.day - i));
      days.push(byDate.get(key) || { date: key, runs: 0, runsPassed: 0, runsTestsFailed: 0, runsPipelineFailed: 0, runsOther: 0, testsPassed: 0, testsFailed: 0, testsFlaky: 0, testsAdded: 0, testsModified: 0, testsDeleted: 0, testsRenamed: 0, codeChanges: 0, commits: 0, configChanges: 0 });
    }
    const runSeries = [
      { key: 'runsPassed', label: 'Passed', color: '--status-good' },
      { key: 'runsTestsFailed', label: 'Tests failed', color: '--status-critical' },
      { key: 'runsPipelineFailed', label: 'Pipeline failed before tests', color: '--status-serious' },
      { key: 'runsOther', label: 'Other (cancelled, no results…)', color: '--status-neutral' },
    ];
    panel.append(
      h('p', { class: 'small muted' }, 'Last 30 days, grouped by IST calendar day. Hover a day for exact values, or switch to the table view.'),
      h('div', { class: 'stack' },
        chartCard('CI runs per day by outcome', 'Pipeline failures (setup/install) are kept apart from test failures.', runSeries, days, (d, se) => d[se.key] || 0,
          [...runSeries.map((se) => ({ label: se.label, value: (d) => d[se.key] || 0 })), { label: 'Tests passed', value: (d) => d.testsPassed }, { label: 'Tests failed', value: (d) => d.testsFailed }]),
        chartCard('Test case changes per day', 'Added, modified, renamed/moved and deleted tests.', [{ key: 'tc', label: 'Test changes', color: '--series-1' }], days, (d) => (d.testsAdded || 0) + (d.testsModified || 0) + (d.testsRenamed || 0) + (d.testsDeleted || 0),
          [{ label: 'Added', value: (d) => d.testsAdded }, { label: 'Modified', value: (d) => d.testsModified }, { label: 'Renamed/moved', value: (d) => d.testsRenamed }, { label: 'Deleted', value: (d) => d.testsDeleted }, { label: 'Code changes', value: (d) => d.codeChanges }, { label: 'Commits', value: (d) => d.commits }])));
  }

  // ── Shell ─────────────────────────────────────────────────────────────────
  const TABS = [
    ['overview', 'Overview', overview],
    ['ask', 'Ask a question', askPanel],
    ['timeline', 'Activity timeline', timeline],
    ['tests', 'Test cases', testsPanel],
    ['framework', 'Framework changes', frameworkPanel],
    ['runs', 'CI/CD runs', runsPanel],
    ['risks', 'Failures & risks', risksPanel],
    ['trends', 'Trends', trendsPanel],
    ['trace', 'Traceability', tracePanel],
  ];

  function start() {
    document.getElementById('repo-name').textContent = I.repo || 'repository';
    document.getElementById('as-of').textContent = `Data as of ${T.formatIst(I.builtAt)} · ${I.eventCount} recorded events · times in IST`;
    const nav = document.getElementById('tabs');
    const main = document.getElementById('main');
    const built = new Set();
    const show = (id) => {
      for (const [tid] of TABS) {
        document.getElementById(`tab-${tid}`).setAttribute('aria-selected', String(tid === id));
        document.getElementById(`panel-${tid}`).classList.toggle('active', tid === id);
      }
      const tab = TABS.find((t) => t[0] === id);
      if (!built.has(id)) {
        built.add(id);
        tab[2](document.getElementById(`panel-${id}`));
      }
      try { localStorage.setItem('qa-intel-tab', id); } catch (e) { /* ignore */ }
    };
    for (const [id, label] of TABS) {
      nav.append(h('button', { id: `tab-${id}`, role: 'tab', 'aria-selected': 'false', onclick: () => show(id) }, label));
      main.append(h('section', { class: 'panel', id: `panel-${id}`, role: 'tabpanel' }));
    }
    document.getElementById('theme').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
    });
    let initial = 'overview';
    try { initial = localStorage.getItem('qa-intel-tab') || 'overview'; } catch (e) { /* ignore */ }
    show(TABS.some((t) => t[0] === initial) ? initial : 'overview');
  }

  if (!I || I.format !== 'qa-intel-index') {
    document.getElementById('main').textContent = 'No QA history data was embedded in this page.';
    return;
  }
  start();
})();

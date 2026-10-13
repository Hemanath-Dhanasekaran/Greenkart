'use strict';

/**
 * Structured diffs for non-test framework files: package.json, lockfiles,
 * playwright.config.js, GitHub Actions workflows and Excel test data.
 * Excel diffs record sheet names, headers and row numbers only — never cell
 * values — so test data never leaks into the history.
 */

const acorn = require('acorn');
const YAML = require('yaml');
const ExcelJS = require('exceljs');
const { sha256 } = require('./util');

function safeJson(buf) {
  try {
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  } catch {
    return undefined;
  }
}

function diffMaps(before = {}, after = {}) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push({ name: k, value: v });
    else if (JSON.stringify(before[k]) !== JSON.stringify(v)) changed.push({ name: k, from: before[k], to: v });
  }
  for (const [k, v] of Object.entries(before)) if (!(k in after)) removed.push({ name: k, value: v });
  return { added, removed, changed };
}

const isEmptyDiff = (d) => !d.added.length && !d.removed.length && !d.changed.length;

function diffPackageJson(beforeBuf, afterBuf) {
  const before = safeJson(beforeBuf) || {};
  const after = safeJson(afterBuf) || {};
  if (before === undefined || after === undefined) return { kind: 'package-json', parseError: true };
  const out = { kind: 'package-json', sections: {} };
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) {
    const d = diffMaps(before[section], after[section]);
    if (!isEmptyDiff(d)) out.sections[section] = d;
  }
  const otherKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const other = [];
  for (const k of otherKeys) {
    if (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts'].includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) other.push(k);
  }
  if (other.length) out.otherFieldsChanged = other;
  out.summary = summarizeSections(out.sections, other);
  return out;
}

function summarizeSections(sections, other = []) {
  const parts = [];
  for (const [name, d] of Object.entries(sections)) {
    const label = name === 'scripts' ? 'script' : name === 'devDependencies' ? 'dev dependency' : 'dependency';
    d.added.forEach((a) => parts.push(`added ${label} ${a.name}${name === 'scripts' ? '' : `@${a.value}`}`));
    d.removed.forEach((a) => parts.push(`removed ${label} ${a.name}`));
    d.changed.forEach((c) => parts.push(name === 'scripts' ? `changed script ${c.name}` : `${c.name} ${c.from} → ${c.to}`));
  }
  if (other.length) parts.push(`changed ${other.join(', ')}`);
  return parts;
}

function diffLockfile(beforeBuf, afterBuf) {
  const before = safeJson(beforeBuf) || {};
  const after = safeJson(afterBuf) || {};
  const versions = (lock) => {
    const out = {};
    for (const [k, v] of Object.entries((lock && lock.packages) || {})) if (k) out[k.replace(/^.*node_modules\//, '')] = v.version;
    return out;
  };
  const d = diffMaps(versions(before), versions(after));
  return {
    kind: 'lockfile',
    packagesAdded: d.added.length,
    packagesRemoved: d.removed.length,
    packagesChanged: d.changed.length,
    summary: [`lockfile: ${d.added.length} package(s) added, ${d.removed.length} removed, ${d.changed.length} version change(s)`],
  };
}

/** Flattens the object passed to defineConfig({...}) into "a.b.c" → source. */
function flattenConfig(source) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  } catch {
    try {
      ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch {
      return null;
    }
  }
  let root = null;
  (function find(node) {
    if (root || !node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'defineConfig' && node.arguments[0] && node.arguments[0].type === 'ObjectExpression') {
      root = node.arguments[0];
      return;
    }
    if (node.type === 'AssignmentExpression' && /module\.exports/.test(source.slice(node.left.start, node.left.end)) && node.right.type === 'ObjectExpression') {
      root = node.right;
      return;
    }
    for (const k of Object.keys(node)) {
      const c = node[k];
      if (Array.isArray(c)) c.forEach(find);
      else if (c && typeof c.type === 'string') find(c);
    }
  })(ast);
  if (!root) return null;
  const out = {};
  const text = (n) => source.slice(n.start, n.end).replace(/\s+/g, ' ').trim();
  (function flat(node, prefix) {
    for (const prop of node.properties) {
      if (prop.type !== 'Property') continue;
      const key = prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
      const p = prefix ? `${prefix}.${key}` : key;
      if (prop.value.type === 'ObjectExpression') flat(prop.value, p);
      else if (key === 'reporter' && prop.value.type === 'ArrayExpression') {
        prop.value.elements.forEach((el, i) => {
          const name = el.type === 'ArrayExpression' ? el.elements[0] : el;
          const reporterName = name && name.type === 'Literal' ? name.value : `#${i}`;
          out[`reporter[${reporterName}]`] = text(el);
        });
      } else out[p] = text(prop.value);
    }
  })(root, '');
  return out;
}

function diffPlaywrightConfig(beforeBuf, afterBuf) {
  const before = beforeBuf ? flattenConfig(beforeBuf.toString('utf8')) : {};
  const after = afterBuf ? flattenConfig(afterBuf.toString('utf8')) : {};
  if (!before || !after) return { kind: 'playwright-config', parseError: true, summary: ['configuration file changed (could not parse settings)'] };
  const d = diffMaps(before, after);
  const summary = [];
  d.added.forEach((a) => summary.push(`${a.name.startsWith('reporter[') ? 'added reporter' : 'added setting'} ${a.name.replace(/^reporter\[|\]$/g, '')}`));
  d.removed.forEach((a) => summary.push(`${a.name.startsWith('reporter[') ? 'removed reporter' : 'removed setting'} ${a.name.replace(/^reporter\[|\]$/g, '')}`));
  d.changed.forEach((c) => summary.push(`${c.name}: ${c.from} → ${c.to}`));
  return { kind: 'playwright-config', settings: d, reporterChanged: [...d.added, ...d.removed, ...d.changed].some((x) => x.name.startsWith('reporter')), summary };
}

function workflowShape(buf) {
  if (!buf) return null;
  let doc;
  try {
    doc = YAML.parse(buf.toString('utf8')) || {};
  } catch {
    return undefined;
  }
  const triggers = doc.on ?? doc.true ?? {}; // YAML 1.1 parsers may read `on` as true
  const triggerMap = typeof triggers === 'string' ? { [triggers]: {} } : Array.isArray(triggers) ? Object.fromEntries(triggers.map((t) => [t, {}])) : triggers || {};
  const jobs = {};
  for (const [id, job] of Object.entries(doc.jobs || {})) {
    const steps = {};
    (job.steps || []).forEach((s, i) => {
      // Unnamed `uses:` steps are keyed by action without version, so v4 → v5 reads as a change.
      const name = s.name || (s.uses ? s.uses.split('@')[0] : null) || (s.run ? String(s.run).split('\n')[0].slice(0, 60) : `step ${i + 1}`);
      steps[name] = { uses: s.uses || null, if: s.if || null, run: s.run ? sha256(s.run).slice(0, 12) : null, with: s.with ? sha256(JSON.stringify(s.with)).slice(0, 12) : null, continueOnError: s['continue-on-error'] || null };
    });
    jobs[id] = { name: job.name || id, runsOn: job['runs-on'] || null, timeout: job['timeout-minutes'] || null, permissions: job.permissions || null, if: job.if || null, steps };
  }
  return { name: doc.name || null, triggers: triggerMap, permissions: doc.permissions || null, concurrency: doc.concurrency || null, jobs };
}

function diffWorkflow(beforeBuf, afterBuf) {
  const before = workflowShape(beforeBuf);
  const after = workflowShape(afterBuf);
  if (before === undefined || after === undefined) return { kind: 'workflow', parseError: true, summary: ['workflow file changed (YAML could not be parsed)'] };
  const b = before || { triggers: {}, jobs: {} };
  const a = after || { triggers: {}, jobs: {} };
  const summary = [];
  const triggers = diffMaps(b.triggers, a.triggers);
  triggers.added.forEach((t) => summary.push(`added trigger ${t.name}${t.name === 'schedule' ? ` (${(t.value || []).map((c) => c.cron).join(', ')})` : ''}`));
  triggers.removed.forEach((t) => summary.push(`removed trigger ${t.name}`));
  triggers.changed.forEach((t) => summary.push(`changed trigger ${t.name}`));
  if (before && after && JSON.stringify(b.permissions ?? null) !== JSON.stringify(a.permissions ?? null)) summary.push('changed workflow permissions');
  const jobs = diffMaps(b.jobs, a.jobs);
  jobs.added.forEach((j) => summary.push(`added job ${j.name}`));
  jobs.removed.forEach((j) => summary.push(`removed job ${j.name}`));
  const stepChanges = {};
  for (const c of jobs.changed) {
    const s = diffMaps(c.from.steps, c.to.steps);
    stepChanges[c.name] = { added: s.added.map((x) => x.name), removed: s.removed.map((x) => x.name), changed: s.changed.map((x) => x.name) };
    s.added.forEach((x) => summary.push(`job ${c.name}: added step "${x.name}"`));
    s.removed.forEach((x) => summary.push(`job ${c.name}: removed step "${x.name}"`));
    s.changed.forEach((x) => {
      const from = x.from.uses;
      const to = x.to.uses;
      summary.push(from && to && from !== to ? `job ${c.name}: "${x.name}" ${from} → ${to}` : `job ${c.name}: changed step "${x.name}"`);
    });
    for (const field of ['runsOn', 'timeout', 'permissions', 'if']) {
      if (JSON.stringify(c.from[field]) !== JSON.stringify(c.to[field])) summary.push(`job ${c.name}: ${field} ${JSON.stringify(c.from[field])} → ${JSON.stringify(c.to[field])}`);
    }
  }
  return {
    kind: 'workflow',
    workflowName: a.name || b.name,
    triggersAfter: Object.keys(a.triggers),
    triggers: { added: triggers.added.map((t) => t.name), removed: triggers.removed.map((t) => t.name), changed: triggers.changed.map((t) => t.name) },
    jobs: { added: jobs.added.map((j) => j.name), removed: jobs.removed.map((j) => j.name) },
    steps: stepChanges,
    summary: summary.length ? summary : ['formatting or comments only'],
  };
}

async function sheetRows(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheets = {};
  wb.eachSheet((ws) => {
    const rows = {};
    let header = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const values = (row.values || []).slice(1).map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')));
      if (n === 1) header = values.map((v) => v.trim());
      rows[n] = sha256(values.join('\u0001'));
    });
    sheets[ws.name] = { header, rows, rowCount: Math.max(0, ...Object.keys(rows).map(Number)) };
  });
  return sheets;
}

/** Sheet-level diff of two .xlsx buffers (row numbers as seen in Excel). */
async function diffExcel(beforeBuf, afterBuf) {
  let before = {};
  let after = {};
  try {
    if (beforeBuf) before = await sheetRows(beforeBuf);
    if (afterBuf) after = await sheetRows(afterBuf);
  } catch (err) {
    return { kind: 'excel', parseError: true, summary: [`workbook changed (could not read it: ${String(err.message).slice(0, 80)})`] };
  }
  const sheets = [];
  const summary = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[name];
    const a = after[name];
    if (!b) {
      sheets.push({ sheet: name, change: 'added', rowCountAfter: a.rowCount, header: a.header });
      summary.push(`added sheet "${name}" (${Math.max(0, a.rowCount - 1)} data rows)`);
      continue;
    }
    if (!a) {
      sheets.push({ sheet: name, change: 'deleted', rowCountBefore: b.rowCount });
      summary.push(`deleted sheet "${name}"`);
      continue;
    }
    const changedRows = [];
    const addedRows = [];
    const removedRows = [];
    for (const n of new Set([...Object.keys(b.rows), ...Object.keys(a.rows)].map(Number))) {
      if (n === 1) continue;
      if (!(n in b.rows)) addedRows.push(n);
      else if (!(n in a.rows)) removedRows.push(n);
      else if (b.rows[n] !== a.rows[n]) changedRows.push(n);
    }
    const headerChanged = JSON.stringify(b.header) !== JSON.stringify(a.header);
    if (!changedRows.length && !addedRows.length && !removedRows.length && !headerChanged) continue;
    const sort = (x) => x.sort((p, q) => p - q);
    sheets.push({
      sheet: name,
      change: 'modified',
      rowCountBefore: b.rowCount,
      rowCountAfter: a.rowCount,
      changedRows: sort(changedRows),
      addedRows: sort(addedRows),
      removedRows: sort(removedRows),
      headerChanged,
      headerAfter: headerChanged ? a.header : undefined,
    });
    const bits = [];
    if (changedRows.length) bits.push(`${changedRows.length} row(s) changed (${compactRows(changedRows)})`);
    if (addedRows.length) bits.push(`${addedRows.length} row(s) added (${compactRows(addedRows)})`);
    if (removedRows.length) bits.push(`${removedRows.length} row(s) removed (${compactRows(removedRows)})`);
    if (headerChanged) bits.push('column headers changed');
    summary.push(`sheet "${name}": ${bits.join(', ')}`);
  }
  return { kind: 'excel', sheets, summary: summary.length ? summary : ['file re-saved, no cell changes'] };
}

function compactRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    out.push(j > i ? `${rows[i]}-${rows[j]}` : `${rows[i]}`);
    i = j;
  }
  return out.join(', ');
}

/** Picks the right diff for a framework file. Returns null for categories without one. */
async function diffConfigFile(filePath, category, beforeBuf, afterBuf) {
  if (category === 'dependencies') {
    if (/package\.json$/.test(filePath)) return diffPackageJson(beforeBuf, afterBuf);
    if (/package-lock\.json$|npm-shrinkwrap\.json$/.test(filePath)) return diffLockfile(beforeBuf, afterBuf);
    return { kind: 'lockfile', summary: ['lockfile changed'] };
  }
  if (category === 'playwright-config') return diffPlaywrightConfig(beforeBuf, afterBuf);
  if (category === 'ci-workflow' && /\.ya?ml$/.test(filePath)) return diffWorkflow(beforeBuf, afterBuf);
  if (category === 'test-data' && /\.xlsx$/i.test(filePath)) return diffExcel(beforeBuf, afterBuf);
  if (category === 'test-data') return { kind: 'test-data', summary: ['test data file changed'] };
  return null;
}

module.exports = { diffConfigFile, diffPackageJson, diffPlaywrightConfig, diffWorkflow, diffExcel, flattenConfig, compactRows };

'use strict';

/**
 * Compares the snapshot of a commit with the snapshot of its first parent and
 * describes what changed: individual tests, framework symbols and framework
 * configuration, each with the evidence used and the tests it may affect.
 */

const path = require('path');
const { similarity } = require('./jsAnalysis');
const { categorizeFile, testsReaching, shouldAnalyze } = require('./snapshot');
const { diffConfigFile } = require('./configDiff');

const TEST_RENAME_THRESHOLD = 0.8;
const SYMBOL_RENAME_THRESHOLD = 0.8;
const GLOBAL_CATEGORIES = new Set(['playwright-config', 'dependencies', 'ci-workflow']);

function listDiff(before = [], after = []) {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((x) => !b.has(x)), removed: before.filter((x) => !a.has(x)) };
}

const callLabel = (c) => (c.type === 'member' ? `${c.object}.${c.name}` : c.type === 'this' ? `this.${c.name}` : c.type === 'new' ? `new ${c.name}` : c.name);

function testDetails(before, after) {
  const d = {};
  const add = (name, diff) => {
    if (diff.added.length || diff.removed.length) d[name] = diff;
  };
  add('assertions', listDiff(before.assertions, after.assertions));
  add('locators', listDiff(before.locators, after.locators));
  add('steps', listDiff(before.steps, after.steps));
  add('methodCalls', listDiff(before.calls.map(callLabel), after.calls.map(callLabel)));
  add('elementRefs', listDiff(before.elementRefs, after.elementRefs));
  add('tags', listDiff(before.tags, after.tags));
  add('modifiers', listDiff(before.modifiers, after.modifiers));
  add('fixtures', listDiff(before.fixtures, after.fixtures));
  if (JSON.stringify(before.data) !== JSON.stringify(after.data)) d.testData = { before: before.data, after: after.data };
  d.bodyChanged = before.bodyHash !== after.bodyHash;
  return d;
}

function describeTestDetails(d) {
  const parts = [];
  const n = (x) => (x ? x.added.length + x.removed.length : 0);
  if (d.assertions) parts.push(`assertions: +${d.assertions.added.length}/-${d.assertions.removed.length}`);
  if (d.locators) parts.push(`locators: +${d.locators.added.length}/-${d.locators.removed.length}`);
  if (d.testData) {
    const rowsB = JSON.stringify(d.testData.before.rowSets);
    const rowsA = JSON.stringify(d.testData.after.rowSets);
    parts.push(rowsB !== rowsA ? `Excel rows ${rowsB} → ${rowsA}` : 'test data usage changed');
  }
  if (d.steps) parts.push(`steps changed (${n(d.steps)})`);
  if (d.methodCalls) parts.push(`page-object calls: +${d.methodCalls.added.length}/-${d.methodCalls.removed.length}`);
  if (d.modifiers && d.modifiers.added.length) parts.push(`now ${d.modifiers.added.join(', ')}`);
  if (d.modifiers && d.modifiers.removed.length) parts.push(`no longer ${d.modifiers.removed.join(', ')}`);
  if (d.tags) parts.push(`tags: +${d.tags.added.join(' ') || '0'}/-${d.tags.removed.join(' ') || '0'}`);
  if (!parts.length && d.bodyChanged) parts.push('test body changed');
  return parts;
}

function publicTest(t) {
  return { key: t.key, title: t.title, titlePath: t.titlePath, file: t.file, line: t.line, tags: t.tags, modifiers: t.modifiers };
}

/** Tests in a changed spec file pair up by key, then by body, then by title, then by similarity. */
function diffTests(parentSnap, childSnap, changedSpecPaths) {
  const oldTests = [...parentSnap.tests.values()].filter((t) => changedSpecPaths.old.has(t.file));
  const newTests = [...childSnap.tests.values()].filter((t) => changedSpecPaths.new.has(t.file));
  const newByKey = new Map(newTests.map((t) => [t.key, t]));
  const results = [];
  const unmatchedOld = [];
  const matchedNew = new Set();

  for (const o of oldTests) {
    const n = newByKey.get(o.key);
    if (!n) {
      unmatchedOld.push(o);
      continue;
    }
    matchedNew.add(n.key);
    const changed = o.bodyHash !== n.bodyHash || JSON.stringify(o.tags) !== JSON.stringify(n.tags) || JSON.stringify(o.modifiers) !== JSON.stringify(n.modifiers);
    if (changed) {
      const details = testDetails(o, n);
      results.push({ type: 'modified', test: publicTest(n), details, summary: describeTestDetails(details), evidence: { basis: 'same file and title', confidence: 'confirmed' } });
    }
  }
  let unmatchedNew = newTests.filter((t) => !matchedNew.has(t.key));

  const pair = (o, n, basis, confidence, score) => {
    unmatchedNew = unmatchedNew.filter((t) => t !== n);
    const moved = o.file !== n.file;
    const renamed = o.title !== n.title || JSON.stringify(o.describePath) !== JSON.stringify(n.describePath);
    const details = testDetails(o, n);
    results.push({
      type: moved && !renamed ? 'moved' : 'renamed',
      test: publicTest(n),
      previous: publicTest(o),
      moved,
      renamed,
      details,
      summary: [
        moved ? `moved from ${o.file}` : null,
        renamed ? `renamed from "${o.titlePath.join(' > ')}"` : null,
        ...(details.bodyChanged ? describeTestDetails(details) : ['body unchanged']),
      ].filter(Boolean),
      evidence: { basis, confidence, similarity: score === undefined ? undefined : Math.round(score * 100) / 100 },
    });
  };

  const stillOld = [];
  for (const o of unmatchedOld) {
    const exact = unmatchedNew.find((n) => n.bodyHash === o.bodyHash);
    if (exact) pair(o, exact, 'identical test body', 'confirmed');
    else stillOld.push(o);
  }
  const stillOld2 = [];
  for (const o of stillOld) {
    const sameTitle = unmatchedNew.find((n) => n.file !== o.file && n.title === o.title);
    if (sameTitle) pair(o, sameTitle, 'same title in another file', 'likely', similarity(o.tokens, sameTitle.tokens));
    else stillOld2.push(o);
  }
  const deleted = [];
  for (const o of stillOld2) {
    let best = null;
    for (const n of unmatchedNew) {
      const score = similarity(o.tokens, n.tokens);
      if (score >= TEST_RENAME_THRESHOLD && (!best || score > best.score)) best = { n, score };
    }
    if (best) pair(o, best.n, `similar test body (${Math.round(best.score * 100)}% token similarity)`, 'inferred', best.score);
    else deleted.push(o);
  }
  for (const o of deleted) results.push({ type: 'deleted', test: publicTest(o), summary: [`removed from ${o.file}`], evidence: { basis: 'test no longer present and no matching test found', confidence: 'confirmed' } });
  for (const n of unmatchedNew) {
    const details = { assertions: n.assertions, locators: n.locators, steps: n.steps, testData: n.data, methodCalls: n.calls.map(callLabel) };
    results.push({ type: 'added', test: publicTest(n), details, summary: [`${n.assertions.length} assertion(s), ${n.steps.length} step(s)`], evidence: { basis: 'no earlier test matches this one', confidence: 'confirmed' } });
  }
  return results;
}

function publicSymbol(s) {
  return { id: s.id, kind: s.kind, name: s.name, qualifiedName: s.qualifiedName, className: s.className, file: s.file, category: s.category, line: s.line, params: s.params, static: s.static || undefined };
}

function symbolDetails(o, n) {
  const d = {};
  if (JSON.stringify(o.params) !== JSON.stringify(n.params)) d.signature = { before: o.params, after: n.params };
  const loc = listDiff(o.locators, n.locators);
  if (loc.added.length || loc.removed.length) d.locators = loc;
  const calls = listDiff((o.calls || []).map(callLabel), (n.calls || []).map(callLabel));
  if (calls.added.length || calls.removed.length) d.calls = calls;
  if (o.properties || n.properties) {
    const before = o.properties || {};
    const after = n.properties || {};
    const props = { added: [], removed: [], changed: [] };
    for (const [k, v] of Object.entries(after)) {
      if (!(k in before)) props.added.push({ name: k, value: v });
      else if (before[k] !== v) props.changed.push({ name: k, from: before[k], to: v });
    }
    for (const k of Object.keys(before)) if (!(k in after)) props.removed.push({ name: k, value: before[k] });
    if (props.added.length || props.removed.length || props.changed.length) d.properties = props;
  }
  if (o.kind === 'class' && o.superClass !== n.superClass) d.superClass = { before: o.superClass, after: n.superClass };
  d.bodyChanged = o.bodyHash !== n.bodyHash;
  d.sizeTokens = { before: (o.tokens || []).length, after: (n.tokens || []).length };
  return d;
}

function describeSymbolDetails(d) {
  const parts = [];
  if (d.signature) parts.push(`parameters (${d.signature.before.join(', ')}) → (${d.signature.after.join(', ')})`);
  if (d.properties) {
    d.properties.added.forEach((p) => parts.push(`added ${p.name} = ${p.value}`));
    d.properties.removed.forEach((p) => parts.push(`removed ${p.name}`));
    d.properties.changed.forEach((p) => parts.push(`${p.name}: ${p.from} → ${p.to}`));
  } else if (d.locators) parts.push(`locators: +${d.locators.added.length}/-${d.locators.removed.length}`);
  if (d.calls) parts.push(`calls: +${d.calls.added.join(', ') || '0'} / -${d.calls.removed.join(', ') || '0'}`);
  if (d.superClass) parts.push(`extends ${d.superClass.before || 'nothing'} → ${d.superClass.after || 'nothing'}`);
  if (!parts.length && d.bodyChanged) parts.push(`logic changed (${d.sizeTokens.before} → ${d.sizeTokens.after} tokens)`);
  return parts;
}

function diffSymbols(parentSnap, childSnap, changedPaths) {
  const oldSyms = [...parentSnap.symbols.values()].filter((s) => changedPaths.old.has(s.file));
  const newSyms = [...childSnap.symbols.values()].filter((s) => changedPaths.new.has(s.file));
  const newById = new Map(newSyms.map((s) => [s.id, s]));
  const results = [];
  const unmatchedOld = [];
  const matched = new Set();
  for (const o of oldSyms) {
    const n = newById.get(o.id);
    if (!n || n.kind !== o.kind) {
      unmatchedOld.push(o);
      continue;
    }
    matched.add(n.id);
    const changed = o.bodyHash !== n.bodyHash || JSON.stringify(o.params) !== JSON.stringify(n.params) || (o.kind === 'class' && o.superClass !== n.superClass);
    if (changed) {
      const details = symbolDetails(o, n);
      results.push({ type: 'modified', symbol: publicSymbol(n), details, summary: describeSymbolDetails(details), evidence: { basis: 'same name in the same file', confidence: 'confirmed' } });
    }
  }
  let unmatchedNew = newSyms.filter((s) => !matched.has(s.id));
  const pair = (o, n, basis, confidence) => {
    unmatchedNew = unmatchedNew.filter((s) => s !== n);
    const details = symbolDetails(o, n);
    results.push({
      type: 'renamed',
      symbol: publicSymbol(n),
      previous: publicSymbol(o),
      moved: o.file !== n.file,
      details,
      summary: [`${o.qualifiedName}${o.file !== n.file ? ` (${o.file})` : ''} → ${n.qualifiedName}`, ...(details.bodyChanged ? describeSymbolDetails(details) : ['body unchanged'])],
      evidence: { basis, confidence },
    });
  };
  const rest = [];
  for (const o of unmatchedOld) {
    const exact = o.kind !== 'class' && unmatchedNew.find((n) => n.kind === o.kind && n.bodyHash === o.bodyHash && n.tokens.length > 4);
    if (exact) pair(o, exact, 'identical body', 'confirmed');
    else rest.push(o);
  }
  const deleted = [];
  for (const o of rest) {
    let best = null;
    for (const n of unmatchedNew) {
      if (n.kind !== o.kind) continue;
      let score;
      if (o.kind === 'class') {
        const shared = (o.members || []).filter((m) => (n.members || []).includes(m)).length;
        score = shared / Math.max(1, Math.max((o.members || []).length, (n.members || []).length));
      } else {
        if (o.file !== n.file && o.className !== n.className) continue;
        score = similarity(o.tokens, n.tokens);
      }
      if (score >= SYMBOL_RENAME_THRESHOLD && (!best || score > best.score)) best = { n, score };
    }
    if (best) pair(o, best.n, o.kind === 'class' ? `${Math.round(best.score * 100)}% of members shared` : `similar body (${Math.round(best.score * 100)}% token similarity)`, 'inferred');
    else deleted.push(o);
  }
  for (const o of deleted) results.push({ type: 'deleted', symbol: publicSymbol(o), summary: [`removed from ${o.file}`], evidence: { basis: 'no matching symbol remains', confidence: 'confirmed' } });
  for (const n of unmatchedNew) {
    results.push({
      type: 'added',
      symbol: publicSymbol(n),
      summary: [n.kind === 'class' ? `new class${n.superClass ? ` extending ${n.superClass}` : ''}` : `new ${n.kind}${n.params && n.params.length ? `(${n.params.join(', ')})` : '()'}`],
      evidence: { basis: 'not present in the parent commit', confidence: 'confirmed' },
    });
  }
  return results;
}

/** Which tests a symbol change can affect, and how confident that link is. */
function symbolImpact(change, parentSnap, childSnap) {
  const id = change.symbol.id;
  const inGlobal = childSnap.globalFiles.has(change.symbol.file) || parentSnap.globalFiles.has(change.symbol.file);
  const snap = change.type === 'deleted' ? parentSnap : childSnap;
  const lookupId = change.type === 'deleted' ? id : id;
  const reached = testsReaching(snap, lookupId);
  if (change.type === 'renamed' && change.previous) {
    for (const r of testsReaching(parentSnap, change.previous.id)) if (!reached.find((x) => x.testKey === r.testKey)) reached.push({ ...r, beforeChange: true });
  }
  const tests = reached.map((r) => ({ testKey: r.testKey, evidence: 'static-call', via: r.via, chain: r.chain }));
  if (inGlobal) {
    return {
      scope: 'global',
      reason: `${change.symbol.file} is loaded by the Playwright configuration, so it can affect every test run (inferred, not a direct call).`,
      tests,
      allTests: [...snap.tests.keys()],
    };
  }
  if (!tests.length) return { scope: 'none', reason: 'No test reaches this code through the static call graph.', tests: [] };
  return { scope: 'linked', reason: `${tests.length} test(s) call this code directly or through other methods (static call graph).`, tests };
}

function excelImpact(details, filePath, childSnap) {
  const base = path.posix.basename(filePath);
  const tests = [];
  const changedSheets = new Map((details.sheets || []).map((s) => [s.sheet, s]));
  for (const [key, r] of childSnap.reach) {
    if (!r.data.files.includes(base)) continue;
    for (const sheetName of r.data.sheets) {
      const s = changedSheets.get(sheetName);
      if (!s) continue;
      const rows = Object.values(r.data.rowSets).flat();
      const touched = [...(s.changedRows || []), ...(s.addedRows || []), ...(s.removedRows || [])];
      if (s.change !== 'modified' || s.headerChanged) tests.push({ testKey: key, evidence: 'static-data-reference', via: `uses sheet "${sheetName}" (${s.change === 'modified' ? 'headers changed' : `sheet ${s.change}`})` });
      else if (rows.length) {
        const hit = rows.filter((x) => touched.includes(x));
        if (hit.length) tests.push({ testKey: key, evidence: 'static-data-reference', via: `uses changed rows ${hit.join(', ')} of sheet "${sheetName}"` });
      } else tests.push({ testKey: key, evidence: 'possible-data-dependency', via: `reads sheet "${sheetName}"; the rows it uses could not be determined statically` });
    }
    if (!r.data.sheets.some((s) => changedSheets.has(s)) && r.data.loadsAllSheets && changedSheets.size) {
      tests.push({ testKey: key, evidence: 'possible-data-dependency', via: 'loads every sheet of the workbook' });
    }
  }
  return {
    scope: tests.length ? 'linked' : 'none',
    reason: tests.length ? `${tests.length} test(s) reference the changed data.` : 'No test references the changed sheets or rows.',
    tests,
  };
}

/**
 * Everything that changed in one commit.
 * @returns {{files, testChanges, symbolChanges, configChanges, notes}}
 */
async function diffCommit({ git, nameStatus, parentSnap, childSnap }) {
  const files = nameStatus.map((f) => ({ ...f, category: categorizeFile(f.path), previousCategory: f.oldPath ? categorizeFile(f.oldPath) : undefined }));
  const oldPaths = new Set();
  const newPaths = new Set();
  for (const f of files) {
    if (f.status !== 'added') oldPaths.add(f.oldPath || f.path);
    if (f.status !== 'deleted') newPaths.add(f.path);
  }
  const specPaths = {
    old: new Set([...oldPaths].filter((p) => categorizeFile(p) === 'test-spec')),
    new: new Set([...newPaths].filter((p) => categorizeFile(p) === 'test-spec')),
  };
  const codePaths = { old: new Set([...oldPaths].filter(shouldAnalyze)), new: new Set([...newPaths].filter(shouldAnalyze)) };

  const testChanges = diffTests(parentSnap, childSnap, specPaths);
  const symbolChanges = diffSymbols(parentSnap, childSnap, codePaths);
  for (const c of symbolChanges) c.impact = symbolImpact(c, parentSnap, childSnap);

  // File-level notes: comment-only edits, parse errors, top-level edits.
  for (const f of files) {
    if (!shouldAnalyze(f.path) || f.status === 'deleted') continue;
    const a = childSnap.analyses[f.path];
    const b = parentSnap.analyses[f.oldPath || f.path];
    if (a && a.parseError) f.note = `could not be parsed (${a.parseError}); changes inside it are not itemised`;
    else if (a && b && a.fileHash === b.fileHash) f.note = 'comments or formatting only — no code change';
    else if (a && b && !testChanges.some((t) => t.test.file === f.path || (t.previous && t.previous.file === f.path)) && !symbolChanges.some((s) => s.symbol.file === f.path)) {
      f.note = 'top-level code changed (imports, constants or exports) — no individual test or method changed';
    }
  }

  const configChanges = [];
  for (const f of files) {
    const category = f.category;
    if (!['dependencies', 'playwright-config', 'ci-workflow', 'test-data'].includes(category)) continue;
    const beforeBlob = f.status === 'added' ? null : parentSnap.files[f.oldPath || f.path];
    const afterBlob = f.status === 'deleted' ? null : childSnap.files[f.path];
    const details = await diffConfigFile(f.path, category, beforeBlob ? git.blob(beforeBlob) : null, afterBlob ? git.blob(afterBlob) : null);
    if (!details) continue;
    let impact;
    if (GLOBAL_CATEGORIES.has(category)) {
      impact = { scope: 'global', reason: category === 'ci-workflow' ? 'Changes how and when the test pipeline runs.' : 'Applies to every test run (inferred).', tests: [], allTests: [...childSnap.tests.keys()] };
    } else if (details.kind === 'excel') impact = excelImpact(details, f.path, childSnap);
    else impact = { scope: 'unknown', reason: 'Data file usage is not traced for this file type.', tests: [] };
    configChanges.push({ file: f.path, previousFile: f.oldPath, status: f.status, category, details, summary: details.summary, impact });
  }

  return { files, testChanges, symbolChanges, configChanges };
}

module.exports = { diffCommit, diffTests, diffSymbols, describeTestDetails, GLOBAL_CATEGORIES };

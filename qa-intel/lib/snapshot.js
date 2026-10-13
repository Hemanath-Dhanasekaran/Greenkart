'use strict';

/**
 * Builds an analysed view of the repository at one commit: every Playwright
 * test, every framework symbol, and a static call graph that links each test
 * to the methods, fixtures and helpers it can reach.
 */

const path = require('path');
const { analyzeSource } = require('./jsAnalysis');

const JS_FILE = /\.(c|m)?js$/;

/** Framework area for a repository path. */
function categorizeFile(filePath) {
  const p = filePath.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  if (lower.startsWith('qa-intel/')) return 'qa-intel-tooling';
  if (lower.startsWith('.github/workflows/')) return 'ci-workflow';
  if (/(^|\/)package(-lock)?\.json$/.test(lower) || /(^|\/)(npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(lower)) return 'dependencies';
  if (/(^|\/)playwright\.config\.(c|m)?[jt]s$/.test(lower)) return 'playwright-config';
  if (/\.(spec|test)\.(c|m)?[jt]s$/.test(lower)) return 'test-spec';
  if (/\.(xlsx|xls|csv)$/.test(lower) || /(^|\/)test-?data\//.test(lower)) return 'test-data';
  if (!JS_FILE.test(lower)) return /\.(md|txt)$/.test(lower) ? 'docs' : 'other';
  const base = path.posix.basename(lower);
  if (/(^|\/)pages?\//.test(lower) || /page\.(c|m)?js$/.test(base) && !/^base/.test(base)) return 'page-object';
  if (/(^|\/)base\//.test(lower) || /^base(page)?\.(c|m)?js$/.test(base)) return 'base-page';
  if (/fixture|basetest/.test(base)) return 'fixture';
  if (/report/.test(base)) return 'reporter';
  if (/excel|testdata|csv/.test(base)) return 'test-data-utility';
  if (/api|request|client|validat/.test(base)) return 'api-utility';
  if (/log/.test(base)) return 'logging-utility';
  return 'utility';
}

const CATEGORY_LABELS = {
  'test-spec': 'Test spec',
  'page-object': 'Page object',
  'base-page': 'Base page',
  fixture: 'Shared fixture',
  reporter: 'Reporter / report utility',
  'test-data-utility': 'Excel test-data utility',
  'api-utility': 'API / validation utility',
  'logging-utility': 'Logging utility',
  utility: 'Helper utility',
  'playwright-config': 'Playwright configuration',
  dependencies: 'Package dependencies',
  'ci-workflow': 'GitHub Actions workflow',
  'test-data': 'Test data file',
  'qa-intel-tooling': 'QA Intelligence tooling',
  docs: 'Documentation',
  other: 'Other',
};

function shouldAnalyze(filePath) {
  return JS_FILE.test(filePath) && !/(^|\/)node_modules\//.test(filePath) && categorizeFile(filePath) !== 'qa-intel-tooling';
}

function testKey(file, titlePath) {
  return `${file}::${titlePath.join(' > ')}`;
}

/**
 * @param git        createGit() instance (or any object with lsTree/blob)
 * @param sha        commit sha, or null for "before the first commit"
 * @param cache      Map shared between snapshots: "<blob>:<path>" → analysis
 */
function buildSnapshot(git, sha, cache = new Map()) {
  const files = sha ? git.lsTree(sha) : {};
  return buildSnapshotFromFiles(sha, files, (blob) => git.blob(blob), cache);
}

function buildSnapshotFromFiles(sha, files, readBlob, cache = new Map()) {
  const analyses = {};
  for (const [filePath, blob] of Object.entries(files)) {
    if (!shouldAnalyze(filePath)) continue;
    const cacheKey = `${blob}:${filePath}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, analyzeSource(readBlob(blob).toString('utf8'), filePath));
    analyses[filePath] = cache.get(cacheKey);
  }

  const tests = new Map();
  const symbols = new Map();
  const classes = new Map(); // "<file>#<Class>" → class symbol

  for (const [file, a] of Object.entries(analyses)) {
    const category = categorizeFile(file);
    for (const t of a.tests) {
      let key = testKey(file, t.titlePath);
      for (let n = 2; tests.has(key); n++) key = `${testKey(file, t.titlePath)} #${n}`;
      tests.set(key, { ...t, key, file });
    }
    for (const s of a.symbols) {
      let id = `${file}#${s.qualifiedName}`;
      for (let n = 2; symbols.has(id); n++) id = `${file}#${s.qualifiedName}~${n}`;
      const sym = { ...s, id, file, category };
      symbols.set(id, sym);
      if (s.kind === 'class') classes.set(`${file}#${s.name}`, sym);
    }
    // Hooks are tracked like methods so a beforeEach change links to the tests in its scope.
    for (const h of a.hooks) {
      const scope = h.describePath.length ? h.describePath.join(' > ') : 'file';
      let id = `${file}#hook:${h.hook}[${scope}]`;
      for (let n = 2; symbols.has(id); n++) id = `${file}#hook:${h.hook}[${scope}]~${n}`;
      h.symbolId = id;
      symbols.set(id, {
        kind: 'hook', name: h.hook, qualifiedName: `${h.hook} (${scope})`, className: null, line: h.line,
        params: [], bodyHash: h.bodyHash, tokens: h.tokens, calls: [], locators: h.locators, fixtures: h.fixtures,
        describePath: h.describePath, id, file, category,
      });
    }
  }

  const fileSet = new Set(Object.keys(files));
  function resolveModule(fromFile, source) {
    if (!source || !source.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), source));
    for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}/index.js`]) if (fileSet.has(candidate)) return candidate;
    return null;
  }

  function findClass(name, fromFile, depth = 0) {
    if (!name || depth > 5) return null;
    if (classes.has(`${fromFile}#${name}`)) return classes.get(`${fromFile}#${name}`);
    const a = analyses[fromFile];
    const req = a && a.requires[name];
    if (req) {
      const target = resolveModule(fromFile, req.source);
      if (target) {
        const wanted = req.imported === '*' ? name : req.imported;
        if (classes.has(`${target}#${wanted}`)) return classes.get(`${target}#${wanted}`);
        const any = [...classes.values()].filter((c) => c.file === target);
        if (any.length === 1) return any[0];
      }
    }
    const global = [...classes.values()].filter((c) => c.name === name);
    return global.length === 1 ? global[0] : null;
  }

  function findMethod(cls, method, depth = 0) {
    if (!cls || depth > 10) return null;
    const id = `${cls.file}#${cls.name}.${method}`;
    if (symbols.has(id)) return symbols.get(id);
    return findMethod(findClass(cls.superClass, cls.file), method, depth + 1);
  }

  function findFunction(name, fromFile) {
    if (symbols.has(`${fromFile}#${name}`) && symbols.get(`${fromFile}#${name}`).kind === 'function') return symbols.get(`${fromFile}#${name}`);
    const req = analyses[fromFile] && analyses[fromFile].requires[name];
    if (req) {
      const target = resolveModule(fromFile, req.source);
      const wanted = req.imported === '*' ? name : req.imported;
      if (target && symbols.has(`${target}#${wanted}`)) return symbols.get(`${target}#${wanted}`);
    }
    return null;
  }

  function fixtureFiles(fromFile) {
    const a = analyses[fromFile];
    const req = a && a.requires.test;
    const target = req ? resolveModule(fromFile, req.source) : null;
    return target ? [target] : [];
  }

  function findFixture(name, files) {
    for (const f of files) if (symbols.has(`${f}#fixture:${name}`)) return symbols.get(`${f}#fixture:${name}`);
    return null;
  }

  /** Resolves one recorded call (from a test, hook or symbol) to a symbol. */
  function resolveCall(call, file, ownerClass) {
    const instances = (analyses[file] && analyses[file].instances) || {};
    switch (call.type) {
      case 'this':
        return ownerClass ? findMethod(ownerClass, call.name) : null;
      case 'super':
        return ownerClass ? findMethod(findClass(ownerClass.superClass, ownerClass.file), call.name) : null;
      case 'member': {
        const instanceClass = instances[call.object] ? findClass(instances[call.object], file) : null;
        if (instanceClass) return findMethod(instanceClass, call.name);
        const staticClass = findClass(call.object, file);
        if (staticClass) return findMethod(staticClass, call.name);
        const req = analyses[file] && analyses[file].requires[call.object];
        const target = req ? resolveModule(file, req.source) : null;
        return target && symbols.has(`${target}#${call.name}`) ? symbols.get(`${target}#${call.name}`) : null;
      }
      case 'ident':
        return findFunction(call.name, file);
      case 'new': {
        const cls = findClass(call.name, file);
        return cls ? (symbols.get(`${cls.file}#${cls.name}.constructor`) || cls) : null;
      }
      default:
        return null;
    }
  }

  // Outgoing edges of each symbol.
  const edges = new Map();
  for (const sym of symbols.values()) {
    const ownerClass = sym.className && sym.kind !== 'class' ? classes.get(`${sym.file}#${sym.className}`) : null;
    const out = new Set();
    for (const call of sym.calls || []) {
      const target = resolveCall(call, sym.file, ownerClass);
      if (target && target.id !== sym.id) out.add(target.id);
    }
    if (sym.kind === 'constructor' && ownerClass) {
      out.add(ownerClass.id);
      const parent = findClass(ownerClass.superClass, ownerClass.file);
      if (parent) out.add((symbols.get(`${parent.file}#${parent.name}.constructor`) || parent).id);
    }
    if (sym.kind === 'class') {
      const parent = findClass(sym.superClass, sym.file);
      if (parent) out.add(parent.id);
    }
    if (sym.kind === 'fixture') {
      for (const dep of sym.fixtures || []) {
        const fx = findFixture(dep, [sym.file]);
        if (fx && fx.id !== sym.id) out.add(fx.id);
      }
    }
    edges.set(sym.id, out);
  }

  // Direct edges + reachability for each test (hooks in scope included).
  const reach = new Map();
  for (const t of tests.values()) {
    const a = analyses[t.file];
    const hooks = a.hooks.filter((h) => h.describePath.every((d, i) => t.describePath[i] === d));
    const direct = new Map(); // symbolId → how the test reaches it
    const fxFiles = fixtureFiles(t.file);
    const addDirect = (sym, via) => sym && !direct.has(sym.id) && direct.set(sym.id, via);
    for (const call of t.calls) addDirect(resolveCall(call, t.file, null), 'test body');
    for (const fx of t.fixtures) addDirect(findFixture(fx, fxFiles), 'test fixture');
    for (const h of hooks) {
      addDirect(symbols.get(h.symbolId), `${h.hook} hook`);
      for (const call of h.calls) addDirect(resolveCall(call, t.file, null), `${h.hook} hook`);
      for (const fx of h.fixtures) addDirect(findFixture(fx, fxFiles), `${h.hook} hook fixture`);
    }
    const paths = new Map();
    const queue = [];
    for (const [id, via] of direct) {
      paths.set(id, { chain: [id], via });
      queue.push(id);
    }
    while (queue.length) {
      const id = queue.shift();
      for (const next of edges.get(id) || []) {
        if (paths.has(next)) continue;
        paths.set(next, { chain: [...paths.get(id).chain, next], via: paths.get(id).via });
        queue.push(next);
      }
    }
    // Data usage: test + hooks in scope + file-level references.
    const sheets = new Set(t.data.sheets);
    const rowSets = { ...t.data.rowSets };
    let loadsAllSheets = t.data.loadsAllSheets;
    for (const h of hooks) {
      h.data.sheets.forEach((s) => sheets.add(s));
      loadsAllSheets = loadsAllSheets || h.data.loadsAllSheets;
    }
    reach.set(t.key, { symbols: paths, data: { files: a.dataFiles, sheets: [...sheets], rowSets, loadsAllSheets } });
  }

  // Files that configure the runner affect every test (inferred, not a call).
  const globalFiles = new Set();
  for (const file of Object.keys(analyses)) {
    if (categorizeFile(file) !== 'playwright-config') continue;
    globalFiles.add(file);
    const a = analyses[file];
    // require()d helpers plus reporter paths given as plain strings,
    // e.g. ['./utils/allureReportGenerator.js', {...}]
    const sources = [...Object.values(a.requires).map((r) => r.source), ...(a.moduleStrings || [])];
    for (const source of sources) {
      const target = resolveModule(file, source);
      if (target) globalFiles.add(target);
    }
  }

  return { sha, files, analyses, tests, symbols, edges, reach, globalFiles, categorize: categorizeFile };
}

/** Tests whose static call graph reaches the symbol, with the evidence chain. */
function testsReaching(snapshot, symbolId) {
  const out = [];
  for (const [key, r] of snapshot.reach) {
    const hit = r.symbols.get(symbolId);
    if (hit) out.push({ testKey: key, via: hit.via, chain: hit.chain });
  }
  return out;
}

module.exports = { categorizeFile, CATEGORY_LABELS, buildSnapshot, buildSnapshotFromFiles, testsReaching, testKey, shouldAnalyze };

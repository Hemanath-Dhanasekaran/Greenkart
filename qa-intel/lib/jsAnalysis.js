'use strict';

/**
 * Static analysis of one JavaScript file with the acorn parser:
 *  - Playwright test cases (title path, tags, assertions, locators, Excel data
 *    usage, fixtures and method calls made by the test and its hooks)
 *  - framework symbols (functions, classes, methods, fixtures) with a
 *    comment/whitespace-insensitive body hash and their outgoing calls
 *  - require() bindings and `x = new Class()` instance bindings
 *
 * Hashes are computed from parser tokens, so reformatting a file or editing
 * comments never shows up as a changed test or method.
 */

const acorn = require('acorn');
const { sha256 } = require('./util');

const TEST_IDENTIFIERS = new Set(['test', 'it']);
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow']);
const DESCRIBE_MODIFIERS = new Set(['only', 'skip', 'fixme', 'serial', 'parallel']);
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const LOCATOR_METHODS = new Set([
  'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId',
  'getByAltText', 'getByTitle', 'frameLocator', '$', '$$', 'waitForSelector',
]);
const IGNORED_CALL_OBJECTS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'Promise', 'Number', 'String', 'Date', 'Boolean',
  'process', 'path', 'fs', 'os', 'test', 'expect', 'Reflect', 'RegExp', 'Symbol', 'Buffer',
]);

function parse(source) {
  const tokens = [];
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, onToken: tokens };
  try {
    return { ast: acorn.parse(source, { ...opts, sourceType: 'script' }), tokens };
  } catch (scriptErr) {
    tokens.length = 0;
    try {
      return { ast: acorn.parse(source, { ...opts, sourceType: 'module' }), tokens };
    } catch {
      return { error: `${scriptErr.message}` };
    }
  }
}

/** Walks every AST node depth-first, setting a non-enumerable parent link. */
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  Object.defineProperty(node, '__parent', { value: parent, enumerable: false, configurable: true, writable: true });
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, node));
    else if (child && typeof child.type === 'string') walk(child, visit, node);
  }
}

function tokenStrings(tokens, start, end) {
  const out = [];
  for (const t of tokens) {
    if (t.start < start) continue;
    if (t.end > end) break;
    const label = t.type.label;
    out.push(t.value !== undefined && t.value !== null ? `${label}:${typeof t.value === 'object' ? String(t.value.pattern || t.value) : t.value}` : label);
  }
  return out;
}

function memberName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Super') return 'super';
  if (node.type === 'MemberExpression' && !node.computed) {
    const obj = memberName(node.object);
    return obj ? `${obj}.${node.property.name}` : null;
  }
  return null;
}

function propertyKey(prop) {
  if (!prop || !prop.key) return null;
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  if (prop.key.type === 'PrivateIdentifier') return `#${prop.key.name}`;
  return null;
}

function isFunctionNode(node) {
  return node && ['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(node.type);
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function createFileAnalyzer(source, filePath) {
  const parsed = parse(source);
  if (parsed.error) return { parseError: parsed.error, file: filePath, tests: [], hooks: [], symbols: [], requires: {}, instances: {}, fixtureDefs: [], dataFiles: [], moduleStrings: [] };
  const { ast, tokens } = parsed;
  const src = (node) => source.slice(node.start, node.end);
  const hashOf = (node) => sha256(tokenStrings(tokens, node.start, node.end).join(' '));

  function staticString(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral') {
      return node.quasis.map((q, i) => q.value.cooked + (node.expressions[i] ? `\${${collapse(src(node.expressions[i]))}}` : '')).join('');
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const l = staticString(node.left);
      const r = staticString(node.right);
      return `${l ?? `\${${collapse(src(node.left))}}`}${r ?? `\${${collapse(src(node.right))}}`}`;
    }
    return null;
  }

  // ── Classify a call expression as test / describe / hook / step ─────────────
  function classifyTestCall(call) {
    const c = call.callee;
    if (c.type === 'Identifier') {
      if (TEST_IDENTIFIERS.has(c.name)) return { role: 'test', modifiers: [] };
      if (c.name === 'describe') return { role: 'describe', modifiers: [] };
      if (HOOKS.has(c.name)) return { role: 'hook', hook: c.name };
      return null;
    }
    const chain = memberName(c);
    if (!chain) return null;
    const parts = chain.split('.');
    if (!TEST_IDENTIFIERS.has(parts[0])) return null;
    const rest = parts.slice(1);
    if (rest[0] === 'describe' && rest.slice(1).every((m) => DESCRIBE_MODIFIERS.has(m))) return { role: 'describe', modifiers: rest.slice(1) };
    if (rest.length === 1 && HOOKS.has(rest[0])) return { role: 'hook', hook: rest[0] };
    if (rest.length === 1 && rest[0] === 'step') return { role: 'step' };
    if (rest.length >= 1 && rest.every((m) => TEST_MODIFIERS.has(m))) return { role: 'test', modifiers: rest };
    return null;
  }

  // ── Call / usage extraction inside any function body ────────────────────────
  function extractUsage(rootNode) {
    const calls = [];
    const assertions = [];
    const locators = [];
    const steps = [];
    const sheets = [];
    const rowSets = {};
    const elementRefs = [];
    let loadsAllSheets = false;
    const seenAssert = new Set();

    walk(rootNode, (node) => {
      if (node !== rootNode && isFunctionNode(node) && node.__parent && node.__parent.type === 'CallExpression') {
        // nested callbacks (test.step bodies, array callbacks) are part of the same test
      }
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const cls = classifyTestCall(node);
        if (cls && cls.role === 'step') {
          const title = staticString(node.arguments[0]);
          if (title) steps.push(collapse(title));
        }
        // expect(...) chains → one assertion per outermost chain
        const isExpect = (callee.type === 'Identifier' && callee.name === 'expect')
          || (callee.type === 'MemberExpression' && memberName(callee) && /^expect\.(soft|poll)$/.test(memberName(callee)));
        if (isExpect) {
          let top = node;
          for (;;) {
            const p = top.__parent;
            if (p && p.type === 'MemberExpression' && p.object === top) top = p;
            else if (p && p.type === 'CallExpression' && p.callee === top) top = p;
            else if (p && p.type === 'AwaitExpression') { top = p; break; }
            else break;
          }
          const text = collapse(src(top)).replace(/^await /, '');
          if (!seenAssert.has(text)) { seenAssert.add(text); assertions.push(text); }
        }
        if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
          const prop = callee.property.name;
          const objName = memberName(callee.object);
          if (LOCATOR_METHODS.has(prop)) locators.push(collapse(`${prop}(${node.arguments.map(src).join(', ')})`));
          if (prop === 'get' && node.arguments[0] && staticString(node.arguments[0]) && objName && /sheet|data|excel/i.test(objName)) sheets.push(staticString(node.arguments[0]));
          if (prop === 'readExcelData' && staticString(node.arguments[1])) sheets.push(staticString(node.arguments[1]));
          if (prop === 'getWorksheetNames') loadsAllSheets = true;
          if (prop === 'selectRows' && staticString(node.arguments[1])) rowSets[`selectRows#${Object.keys(rowSets).length + 1}`] = expandRows(staticString(node.arguments[1]));
          if (callee.object.type === 'ThisExpression') calls.push({ type: 'this', name: prop });
          else if (callee.object.type === 'Super') calls.push({ type: 'super', name: prop });
          else if (callee.object.type === 'Identifier' && !IGNORED_CALL_OBJECTS.has(callee.object.name)) calls.push({ type: 'member', object: callee.object.name, name: prop });
        } else if (callee.type === 'Identifier' && !['expect', 'require', 'test', 'it', 'describe'].includes(callee.name)) {
          calls.push({ type: 'ident', name: callee.name });
        }
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier') calls.push({ type: 'new', name: node.callee.name });
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /rows?$/i.test(node.id.name) && node.init && node.init.type === 'ArrayExpression') {
        const values = node.init.elements.map((e) => (e && e.type === 'Literal' && typeof e.value === 'number' ? e.value : null));
        if (values.length && values.every((v) => v !== null)) rowSets[node.id.name] = values;
      }
      // page-object element references, e.g. homePage.brandLogo (not called)
      if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier') {
        const p = node.__parent;
        const called = p && p.type === 'CallExpression' && p.callee === node;
        if (!called && /page$/i.test(node.object.name) && node.object.name !== 'page') elementRefs.push(`${node.object.name}.${node.property.name}`);
      }
      return true;
    });

    return {
      calls: dedupeCalls(calls),
      assertions,
      locators: [...new Set(locators)],
      steps,
      elementRefs: [...new Set(elementRefs)],
      data: { sheets: [...new Set(sheets)], rowSets, loadsAllSheets },
    };
  }

  function paramFixtures(fn) {
    const first = fn && fn.params && fn.params[0];
    if (!first || first.type !== 'ObjectPattern') return [];
    return first.properties.map(propertyKey).filter(Boolean);
  }

  // ── Walk the program for tests, describes and hooks ────────────────────────
  const tests = [];
  const hooks = [];

  function visitTestScope(node, describePath) {
    walk(node, (n) => {
      if (n.type !== 'CallExpression') return true;
      const cls = classifyTestCall(n);
      if (!cls) return true;
      const fn = [...n.arguments].reverse().find(isFunctionNode);
      if (cls.role === 'describe') {
        const title = staticString(n.arguments[0]);
        const path = title !== null && title !== undefined ? [...describePath, collapse(title)] : describePath;
        if (fn) visitTestScope(fn.body, path);
        return false;
      }
      if (cls.role === 'hook') {
        if (fn) {
          const usage = extractUsage(fn.body);
          hooks.push({ hook: cls.hook, describePath, fixtures: paramFixtures(fn), ...usage, line: n.loc.start.line, bodyHash: hashOf(fn.body), tokens: tokenStrings(tokens, fn.body.start, fn.body.end) });
        }
        return false;
      }
      if (cls.role === 'test') {
        const title = staticString(n.arguments[0]);
        if (title === null || title === undefined || !fn) return false; // e.g. test.skip(condition) inside a test
        const options = n.arguments.find((a) => a.type === 'ObjectExpression');
        const tags = [...(collapse(title).match(/@[\w-]+/g) || [])];
        if (options) {
          for (const prop of options.properties) {
            if (propertyKey(prop) === 'tag') {
              const vals = prop.value.type === 'ArrayExpression' ? prop.value.elements : [prop.value];
              vals.forEach((v) => staticString(v) && tags.push(staticString(v)));
            }
          }
        }
        const usage = extractUsage(fn.body);
        const cleanTitle = collapse(title);
        const tokenList = tokenStrings(tokens, n.start, n.end);
        tests.push({
          title: cleanTitle,
          describePath,
          titlePath: [...describePath, cleanTitle],
          modifiers: cls.modifiers,
          tags: [...new Set(tags)],
          line: n.loc.start.line,
          bodyHash: hashOf(fn.body),
          fullHash: sha256(tokenList.join(' ')),
          tokens: tokenStrings(tokens, fn.body.start, fn.body.end),
          fixtures: paramFixtures(fn),
          ...usage,
        });
        return false;
      }
      return true;
    });
  }
  visitTestScope(ast, []);

  // ── Framework symbols ───────────────────────────────────────────────────────
  const symbols = [];
  const requires = {};
  const instances = {};
  const fixtureDefs = [];

  function addFunctionSymbol(name, fn, kind, extra = {}) {
    const usage = extractUsage(fn.body || fn);
    symbols.push({
      kind,
      name,
      qualifiedName: extra.qualifiedName || name,
      className: extra.className || null,
      line: (extra.node || fn).loc.start.line,
      params: fn.params ? fn.params.map((p) => collapse(src(p))) : [],
      async: Boolean(fn.async),
      static: Boolean(extra.static),
      bodyHash: hashOf(fn.body || fn),
      tokens: tokenStrings(tokens, (fn.body || fn).start, (fn.body || fn).end),
      calls: usage.calls,
      locators: usage.locators,
      properties: extra.properties || null,
      fixtures: extra.fixtures || [],
    });
  }

  function constructorProperties(fn) {
    const props = {};
    walk(fn.body, (n) => {
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'ThisExpression' && !n.left.computed) {
        props[n.left.property.name] = collapse(src(n.right));
      }
      return !(n !== fn.body && isFunctionNode(n));
    });
    return props;
  }

  function addClass(name, cls, node) {
    const superClass = cls.superClass ? memberName(cls.superClass) || collapse(src(cls.superClass)) : null;
    const memberNames = [];
    for (const member of cls.body.body) {
      if (member.type === 'MethodDefinition') {
        const mName = propertyKey(member) || '[computed]';
        const kind = member.kind === 'constructor' ? 'constructor' : member.kind === 'get' ? 'getter' : member.kind === 'set' ? 'setter' : 'method';
        memberNames.push(mName);
        addFunctionSymbol(mName, member.value, kind, {
          qualifiedName: `${name}.${mName}`,
          className: name,
          static: member.static,
          node: member,
          properties: kind === 'constructor' ? constructorProperties(member.value) : null,
        });
      } else if (member.type === 'PropertyDefinition' && member.value && isFunctionNode(member.value)) {
        const mName = propertyKey(member) || '[computed]';
        memberNames.push(mName);
        addFunctionSymbol(mName, member.value, 'method', { qualifiedName: `${name}.${mName}`, className: name, static: member.static, node: member });
      }
    }
    symbols.push({
      kind: 'class',
      name,
      qualifiedName: name,
      className: name,
      superClass,
      line: node.loc.start.line,
      members: memberNames,
      // A class's own hash covers only its heritage; members are tracked individually.
      bodyHash: sha256(`class ${name} extends ${superClass || ''}`),
      tokens: [],
      calls: [],
      locators: [],
    });
  }

  function addFixturesFromExtend(call) {
    const obj = call.arguments[0];
    if (!obj || obj.type !== 'ObjectExpression') return;
    for (const prop of obj.properties) {
      const key = propertyKey(prop);
      if (!key) continue;
      let fn = prop.value;
      if (fn && fn.type === 'ArrayExpression') fn = fn.elements.find(isFunctionNode); // [fn, { auto: true }]
      if (!isFunctionNode(fn)) continue;
      fixtureDefs.push(key);
      addFunctionSymbol(`fixture:${key}`, fn, 'fixture', { qualifiedName: `fixture:${key}`, node: prop, fixtures: paramFixtures(fn) });
    }
  }

  function noteRequire(id, init) {
    let call = init;
    let picked = null;
    if (call && call.type === 'MemberExpression' && !call.computed && call.object.type === 'CallExpression') {
      picked = call.property.name;
      call = call.object;
    }
    if (!call || call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'require') return false;
    const source = staticString(call.arguments[0]);
    if (!source) return false;
    if (id.type === 'Identifier') requires[id.name] = { source, imported: picked || '*' };
    else if (id.type === 'ObjectPattern') {
      for (const p of id.properties) {
        const key = propertyKey(p);
        const local = p.value && p.value.type === 'Identifier' ? p.value.name : key;
        if (key) requires[local] = { source, imported: key };
      }
    }
    return true;
  }

  for (const stmt of ast.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) addFunctionSymbol(stmt.id.name, stmt, 'function', { node: stmt });
    else if (stmt.type === 'ClassDeclaration' && stmt.id) addClass(stmt.id.name, stmt, stmt);
    else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (noteRequire(d.id, d.init)) continue;
        if (d.id.type !== 'Identifier' || !d.init) continue;
        if (isFunctionNode(d.init)) addFunctionSymbol(d.id.name, d.init, 'function', { node: d });
        else if (d.init.type === 'ClassExpression') addClass(d.id.name, d.init, d);
        else if (d.init.type === 'CallExpression' && d.init.callee.type === 'MemberExpression' && d.init.callee.property.name === 'extend') addFixturesFromExtend(d.init);
      }
    } else if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression') {
      const { left, right } = stmt.expression;
      const target = memberName(left);
      if (target && /^(module\.)?exports\.\w+$/.test(target)) {
        const name = target.split('.').pop();
        if (isFunctionNode(right)) addFunctionSymbol(name, right, 'function', { node: stmt });
        else if (right.type === 'ClassExpression') addClass(name, right, stmt);
        else if (right.type === 'CallExpression' && right.callee.type === 'MemberExpression' && right.callee.property.name === 'extend') addFixturesFromExtend(right);
      } else if (target === 'module.exports' && right.type === 'ClassExpression' && right.id) addClass(right.id.name, right, stmt);
    }
  }

  // Instance bindings anywhere in the file: `homePage = new HomePage(...)`
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && n.init.type === 'NewExpression' && n.init.callee.type === 'Identifier') instances[n.id.name] = n.init.callee.name;
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.right.type === 'NewExpression' && n.right.callee.type === 'Identifier') instances[n.left.name] = n.right.callee.name;
    if (n.type === 'VariableDeclarator' && n.id && n.init) noteRequire(n.id, n.init);
    return true;
  });

  const moduleStrings = [...new Set(tokens
    .filter((t) => t.type.label === 'string' && /^\.\.?\/.*\.(c|m)?js$/.test(t.value))
    .map((t) => t.value))];

  const dataFiles = [...new Set((source.match(/['"`][^'"`\n]*\.(?:xlsx|xls|csv|json)['"`]/g) || []).map((s) => s.slice(1, -1).split('/').pop()))]
    .filter((f) => !/package(-lock)?\.json$/.test(f));

  const fileHash = sha256(tokenStrings(tokens, 0, source.length).join(' '));

  return { file: filePath, fileHash, tests, hooks, symbols, requires, instances, fixtureDefs, dataFiles, moduleStrings };
}

function dedupeCalls(calls) {
  const seen = new Set();
  return calls.filter((c) => {
    const k = `${c.type}|${c.object || ''}|${c.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "2,4,6-8" → [2,4,6,7,8] (mirrors ExcelHelper.selectRows syntax). */
function expandRows(selection) {
  const out = [];
  for (const part of String(selection).split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) continue;
    for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]) && out.length < 5000; n++) out.push(n);
  }
  return out;
}

/** Dice coefficient over token bigrams: 1 = identical token stream. */
function similarity(tokensA, tokensB) {
  if (!tokensA.length && !tokensB.length) return 1;
  if (tokensA.length < 2 || tokensB.length < 2) return tokensA.join(' ') === tokensB.join(' ') ? 1 : 0;
  const grams = (t) => {
    const m = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const g = `${t[i]}\u0000${t[i + 1]}`;
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const a = grams(tokensA);
  const b = grams(tokensB);
  let overlap = 0;
  for (const [g, n] of a) overlap += Math.min(n, b.get(g) || 0);
  return (2 * overlap) / (tokensA.length - 1 + tokensB.length - 1);
}

function analyzeSource(source, filePath) {
  return createFileAnalyzer(source, filePath);
}

module.exports = { analyzeSource, similarity, expandRows };

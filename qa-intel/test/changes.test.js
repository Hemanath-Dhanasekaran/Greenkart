'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGit } = require('../lib/git');
const { buildSnapshot } = require('../lib/snapshot');
const { diffCommit } = require('../lib/changes');
const { makeRepo, SPEC_V1, PAGE_V1, FIXTURE_V1 } = require('./helpers');

async function diffAt(repo, sha) {
  const git = createGit(repo.dir);
  const parent = git.commitMeta(sha).parents[0] || null;
  return diffCommit({ git, nameStatus: git.nameStatus(sha, parent), parentSnap: buildSnapshot(git, parent), childSnap: buildSnapshot(git, sha) });
}
const kinds = (d) => d.testChanges.map((c) => `${c.type}:${c.test.title}`).sort();
const syms = (d) => d.symbolChanges.map((c) => `${c.type}:${c.symbol.qualifiedName}`).sort();

test('test case lifecycle: added, modified, renamed, moved, deleted', async () => {
  const r = makeRepo();
  r.write('tests/cart.spec.js', SPEC_V1);
  r.write('Pages/HomePage.js', PAGE_V1);
  r.write('utils/baseTest.js', FIXTURE_V1);
  const c1 = r.commit('initial', '2026-10-01T10:00:00+05:30');
  assert.deepEqual(kinds(await diffAt(r, c1)), ['added:adds a product @smoke', 'added:checks totals']);

  // modified: assertion + Excel rows change
  r.write('tests/cart.spec.js', SPEC_V1.replace("toHaveText('10')", "toHaveText('20')").replace('[2, 3]', '[4, 5]'));
  const c2 = r.commit('change expectation', '2026-10-02T10:00:00+05:30');
  const d2 = await diffAt(r, c2);
  assert.deepEqual(kinds(d2), ['modified:adds a product @smoke', 'modified:checks totals']);
  const totals = d2.testChanges.find((c) => c.test.title === 'checks totals');
  assert.deepEqual(totals.details.assertions, { added: ["expect(home.total).toHaveText('20')"], removed: ["expect(home.total).toHaveText('10')"] });
  const rows = d2.testChanges.find((c) => c.test.title === 'adds a product @smoke');
  assert.deepEqual(rows.details.testData.after.rowSets, { EXCEL_ROWS: [4, 5] });

  // renamed: same body, new title → one rename, not delete + add
  const spec3 = SPEC_V1.replace("toHaveText('10')", "toHaveText('20')").replace('[2, 3]', '[4, 5]').replace("'checks totals'", "'validates cart totals'");
  r.write('tests/cart.spec.js', spec3);
  const c3 = r.commit('rename', '2026-10-03T10:00:00+05:30');
  const d3 = await diffAt(r, c3);
  assert.deepEqual(kinds(d3), ['renamed:validates cart totals']);
  assert.equal(d3.testChanges[0].previous.title, 'checks totals');
  assert.equal(d3.testChanges[0].evidence.confidence, 'confirmed');

  // moved: test goes to another file unchanged
  const moved = `const { test, expect } = require('../utils/baseTest.js');
const { HomePage } = require('../Pages/HomePage.js');
let home;
test.beforeEach(async ({ page }) => { home = new HomePage(page); });
test.describe('Cart', () => {
  test('validates cart totals', async () => {
    await home.addToCart('Apple');
    await expect(home.total).toHaveText('20');
  });
});
`;
  r.write('tests/totals.spec.js', moved);
  r.write('tests/cart.spec.js', spec3.replace(/\n  test\('validates cart totals'[\s\S]*?\n  \}\);\n/, '\n'));
  const c4 = r.commit('move', '2026-10-04T10:00:00+05:30');
  const d4 = await diffAt(r, c4);
  assert.deepEqual(kinds(d4), ['moved:validates cart totals']);
  assert.equal(d4.testChanges[0].previous.file, 'tests/cart.spec.js');
  assert.equal(d4.testChanges[0].test.file, 'tests/totals.spec.js');

  // deleted
  r.remove('tests/totals.spec.js');
  const c5 = r.commit('delete', '2026-10-05T10:00:00+05:30');
  assert.deepEqual(kinds(await diffAt(r, c5)), ['deleted:validates cart totals']);
});

test('genuinely new test is not mistaken for a rename of a kept test', async () => {
  const r = makeRepo();
  r.write('tests/a.spec.js', "const { test } = require('@playwright/test');\ntest('one', async ({ page }) => { await page.goto('/a'); });\n");
  r.commit('a', '2026-10-01T10:00:00+05:30');
  r.write('tests/a.spec.js', "const { test } = require('@playwright/test');\ntest('one', async ({ page }) => { await page.goto('/a'); });\ntest('two', async ({ page }) => { await page.goto('/a'); });\n");
  const c = r.commit('copy test', '2026-10-02T10:00:00+05:30');
  assert.deepEqual(kinds(await diffAt(r, c)), ['added:two']);
});

test('method changes: added, modified, renamed, deleted; comment-only edits ignored', async () => {
  const r = makeRepo();
  r.write('tests/cart.spec.js', SPEC_V1);
  r.write('Pages/HomePage.js', PAGE_V1);
  r.write('utils/baseTest.js', FIXTURE_V1);
  r.commit('initial', '2026-10-01T10:00:00+05:30');

  r.write('Pages/HomePage.js', PAGE_V1.replace('/** Opens the home page. */', '/** Opens the landing page (docs only). */'));
  const c2 = r.commit('docs', '2026-10-02T10:00:00+05:30');
  const d2 = await diffAt(r, c2);
  assert.deepEqual(syms(d2), []);
  assert.match(d2.files.find((f) => f.path === 'Pages/HomePage.js').note, /comments or formatting only/);

  r.write('Pages/HomePage.js', PAGE_V1
    .replace("await this.page.click('text=' + name);", "await this.page.click('text=' + name);\n    await this.page.waitForTimeout(10);")
    .replace("this.total = page.locator('.total');", "this.total = page.locator('#cart-total');")
    .replace('async unused() { return 1; }', 'async helperNew(a, b) { return a + b; }\n\n  async unusedRenamed() { return 1; }'));
  const c3 = r.commit('code', '2026-10-03T10:00:00+05:30');
  const d3 = await diffAt(r, c3);
  assert.deepEqual(syms(d3), ['added:HomePage.helperNew', 'modified:HomePage.addToCart', 'modified:HomePage.constructor', 'renamed:HomePage.unusedRenamed']);
  const ctor = d3.symbolChanges.find((c) => c.symbol.qualifiedName === 'HomePage.constructor');
  assert.deepEqual(ctor.details.properties.changed, [{ name: 'total', from: "page.locator('.total')", to: "page.locator('#cart-total')" }]);
  const add = d3.symbolChanges.find((c) => c.symbol.qualifiedName === 'HomePage.addToCart');
  assert.equal(add.impact.scope, 'linked');
  assert.deepEqual(add.impact.tests.map((t) => t.testKey), ['tests/cart.spec.js::Cart > checks totals']);
  const helper = d3.symbolChanges.find((c) => c.symbol.qualifiedName === 'HomePage.helperNew');
  assert.equal(helper.impact.scope, 'none', 'a method in the same file is not counted as covered');

  r.write('Pages/HomePage.js', PAGE_V1.replace('async unused() { return 1; }', ''));
  const c4 = r.commit('delete', '2026-10-04T10:00:00+05:30');
  const d4 = await diffAt(r, c4);
  assert.ok(syms(d4).includes('deleted:HomePage.helperNew'));
});

test('config, dependency and workflow diffs are structured', async () => {
  const r = makeRepo();
  r.write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'playwright test' }, devDependencies: { '@playwright/test': '^1.50.0' } }));
  r.write('playwright.config.js', "const { defineConfig } = require('@playwright/test');\nmodule.exports = defineConfig({ retries: 0, reporter: [['list'], ['html', { open: 'never' }]] });\n");
  r.write('.github/workflows/ci.yml', 'name: CI\non:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n');
  r.commit('initial', '2026-10-01T10:00:00+05:30');
  r.write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'playwright test', lint: 'eslint .' }, devDependencies: { '@playwright/test': '^1.55.0', yaml: '2.9.1' } }));
  r.write('playwright.config.js', "const { defineConfig } = require('@playwright/test');\nmodule.exports = defineConfig({ retries: 2, reporter: [['list'], ['json', { outputFile: 'r.json' }]] });\n");
  r.write('.github/workflows/ci.yml', "name: CI\non:\n  push:\n  schedule:\n    - cron: '30 3 * * *'\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci\n");
  const c = r.commit('config', '2026-10-02T10:00:00+05:30');
  const d = await diffAt(r, c);
  const by = Object.fromEntries(d.configChanges.map((x) => [x.file, x]));
  assert.ok(by['package.json'].summary.includes('added script lint'));
  assert.ok(by['package.json'].summary.includes('@playwright/test ^1.50.0 → ^1.55.0'));
  assert.ok(by['package.json'].summary.includes('added dev dependency yaml@2.9.1'));
  assert.ok(by['playwright.config.js'].summary.includes('retries: 0 → 2'));
  assert.ok(by['playwright.config.js'].summary.includes('added reporter json'));
  assert.ok(by['playwright.config.js'].summary.includes('removed reporter html'));
  assert.ok(by['.github/workflows/ci.yml'].summary.some((s) => /added trigger schedule \(30 3 \* \* \*\)/.test(s)));
  assert.ok(by['.github/workflows/ci.yml'].summary.some((s) => s.includes('actions/checkout@v4 → actions/checkout@v5')));
  assert.equal(by['playwright.config.js'].impact.scope, 'global');
});

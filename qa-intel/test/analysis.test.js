'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSource } = require('../lib/jsAnalysis');
const { buildSnapshotFromFiles, categorizeFile } = require('../lib/snapshot');
const { SPEC_V1, PAGE_V1, FIXTURE_V1 } = require('./helpers');

test('discovers individual tests with describe path, tags and modifiers', () => {
  const src = `
    const { test, expect } = require('@playwright/test');
    test.describe('Outer', () => {
      test.describe.serial('Inner', () => {
        test('first @fast', async () => { expect(1).toBe(1); });
        test.skip('skipped one', async () => {});
        test(\`templated \${1 + 1}\`, { tag: ['@slow'] }, async ({ page }) => {
          await page.getByRole('button', { name: 'Go' }).click();
          await expect(page.locator('#x')).toHaveText('ok');
        });
      });
      test('in outer', async () => {
        test.skip(process.env.CI, 'not on CI'); // conditional skip, not a test
      });
    });
    test.fixme('top level', async () => {});
  `;
  const a = analyzeSource(src, 'tests/a.spec.js');
  assert.deepEqual(a.tests.map((t) => t.titlePath.join(' > ')), [
    'Outer > Inner > first @fast',
    'Outer > Inner > skipped one',
    'Outer > Inner > templated ${1 + 1}',
    'Outer > in outer',
    'top level',
  ]);
  assert.deepEqual(a.tests[0].tags, ['@fast']);
  assert.deepEqual(a.tests[1].modifiers, ['skip']);
  assert.deepEqual(a.tests[2].tags, ['@slow']);
  assert.deepEqual(a.tests[2].fixtures, ['page']);
  assert.equal(a.tests[2].assertions.length, 1);
  assert.match(a.tests[2].assertions[0], /toHaveText\('ok'\)/);
  assert.ok(a.tests[2].locators.some((l) => l.startsWith("getByRole('button'")));
  assert.deepEqual(a.tests[4].modifiers, ['fixme']);
});

test('extracts Excel data usage and page-object calls', () => {
  const a = analyzeSource(SPEC_V1, 'tests/cart.spec.js');
  const t = a.tests[0];
  assert.deepEqual(t.data.rowSets, { EXCEL_ROWS: [2, 3] });
  assert.ok(t.calls.some((c) => c.object === 'home' && c.name === 'open'));
  assert.equal(a.instances.home, 'HomePage');
  assert.equal(a.hooks.length, 1);
  assert.equal(a.hooks[0].hook, 'beforeEach');
});

test('finds classes, methods, functions and fixtures', () => {
  const page = analyzeSource(PAGE_V1, 'Pages/HomePage.js');
  assert.deepEqual(page.symbols.map((s) => s.qualifiedName).sort(), [
    'BasePage', 'BasePage.constructor', 'BasePage.step',
    'HomePage', 'HomePage.addToCart', 'HomePage.constructor', 'HomePage.open', 'HomePage.unused',
  ]);
  const ctor = page.symbols.find((s) => s.qualifiedName === 'HomePage.constructor');
  assert.equal(ctor.properties.logo, "page.locator('.logo')");
  const fx = analyzeSource(FIXTURE_V1, 'utils/baseTest.js');
  assert.deepEqual(fx.symbols.map((s) => s.qualifiedName), ['fixture:log']);
  const fn = analyzeSource('function a(x) { return b(x); }\nconst b = (y) => y * 2;\nmodule.exports.c = function () {};', 'utils/x.js');
  assert.deepEqual(fn.symbols.map((s) => `${s.kind}:${s.name}`), ['function:a', 'function:b', 'function:c']);
});

test('comment and formatting changes do not change hashes', () => {
  const a = analyzeSource(PAGE_V1, 'p.js');
  const b = analyzeSource(PAGE_V1.replace('/** Opens the home page. */', '// totally different comment\n  //').replace("await this.page.goto('/');", "await   this.page.goto( '/' ) ;"), 'p.js');
  const open = (x) => x.symbols.find((s) => s.qualifiedName === 'HomePage.open').bodyHash;
  assert.equal(open(a), open(b));
  assert.equal(a.fileHash, analyzeSource(`${PAGE_V1}\n// trailing comment\n`, 'p.js').fileHash);
});

test('unparseable files are reported, not fatal', () => {
  const a = analyzeSource('function (', 'bad.js');
  assert.ok(a.parseError);
  assert.equal(a.symbols.length, 0);
});

test('static call graph links tests to page-object methods through hooks and inheritance', () => {
  const files = { 'tests/cart.spec.js': 'b1', 'Pages/HomePage.js': 'b2', 'utils/baseTest.js': 'b3' };
  const blobs = { b1: SPEC_V1, b2: PAGE_V1, b3: FIXTURE_V1 };
  const snap = buildSnapshotFromFiles('sha', files, (b) => Buffer.from(blobs[b]));
  const key = 'tests/cart.spec.js::Cart > checks totals';
  const reach = snap.reach.get(key).symbols;
  assert.ok(reach.has('Pages/HomePage.js#HomePage.addToCart'));
  assert.ok(reach.has('Pages/HomePage.js#BasePage.step'), 'reaches inherited method via this.step()');
  assert.ok(reach.has('Pages/HomePage.js#HomePage.constructor'), 'reaches constructor via beforeEach');
  assert.ok(!reach.has('Pages/HomePage.js#HomePage.open'), 'does not reach methods it never calls');
  assert.ok(!reach.has('Pages/HomePage.js#HomePage.unused'));
  const first = snap.reach.get('tests/cart.spec.js::Cart > adds a product @smoke').symbols;
  assert.ok(first.has('utils/baseTest.js#fixture:log'), 'fixture used through test parameters');
  assert.deepEqual(first.get('Pages/HomePage.js#HomePage.open').chain, ['Pages/HomePage.js#HomePage.open']);
});

test('categorises framework files', () => {
  assert.equal(categorizeFile('tests/a.spec.js'), 'test-spec');
  assert.equal(categorizeFile('Pages/CartPage.js'), 'page-object');
  assert.equal(categorizeFile('Base/Basepage.js'), 'base-page');
  assert.equal(categorizeFile('utils/baseTest.js'), 'fixture');
  assert.equal(categorizeFile('utils/excelHelper.js'), 'test-data-utility');
  assert.equal(categorizeFile('utils/apiClient.js'), 'api-utility');
  assert.equal(categorizeFile('utils/allureReportGenerator.js'), 'reporter');
  assert.equal(categorizeFile('playwright.config.js'), 'playwright-config');
  assert.equal(categorizeFile('package.json'), 'dependencies');
  assert.equal(categorizeFile('.github/workflows/playwright.yml'), 'ci-workflow');
  assert.equal(categorizeFile('testdata/GreenKart-TestData.xlsx'), 'test-data');
  assert.equal(categorizeFile('qa-intel/lib/query.js'), 'qa-intel-tooling');
});

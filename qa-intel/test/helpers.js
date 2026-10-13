'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function tmpDir(prefix = 'qa-intel-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  }).trim();
}

/** A throwaway repository whose commits get explicit dates. */
function makeRepo() {
  const dir = tmpDir('qa-intel-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test Author']);
  git(dir, ['config', 'user.email', 'author@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return {
    dir,
    write(file, content) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    },
    remove(file) {
      fs.rmSync(path.join(dir, file), { force: true });
    },
    commit(message, date) {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      return git(dir, ['rev-parse', 'HEAD']);
    },
    git: (args) => git(dir, args),
  };
}

const SPEC_V1 = `const { test, expect } = require('../utils/baseTest.js');
const { HomePage } = require('../Pages/HomePage.js');

test.describe('Cart', () => {
  let home;
  test.beforeEach(async ({ page }) => { home = new HomePage(page); });

  test('adds a product @smoke', async ({ log }) => {
    const EXCEL_ROWS = [2, 3];
    await home.open();
    await expect(home.logo).toBeVisible();
  });

  test('checks totals', async () => {
    await home.addToCart('Apple');
    await expect(home.total).toHaveText('10');
  });
});
`;

const PAGE_V1 = `class BasePage {
  constructor(page) { this.page = page; }
  async step(msg) { return msg; }
}

class HomePage extends BasePage {
  constructor(page) {
    super(page);
    this.logo = page.locator('.logo');
    this.total = page.locator('.total');
  }

  /** Opens the home page. */
  async open() {
    await this.page.goto('/');
  }

  async addToCart(name) {
    await this.step('add ' + name);
    await this.page.click('text=' + name);
  }

  async unused() { return 1; }
}

module.exports = { HomePage, BasePage };
`;

const FIXTURE_V1 = `const { test: base, expect } = require('@playwright/test');
exports.test = base.extend({
  log: async ({}, use) => { await use(async () => {}); },
});
exports.expect = expect;
`;

function minimalRun(over = {}) {
  return {
    id: 1001,
    name: 'Playwright Tests',
    path: '.github/workflows/playwright.yml',
    workflow_id: 7,
    run_number: 1,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    display_title: 'Commit',
    created_at: '2026-10-13T03:30:00Z',
    run_started_at: '2026-10-13T03:30:05Z',
    updated_at: '2026-10-13T03:40:00Z',
    html_url: 'https://github.com/o/r/actions/runs/1001',
    actor: { login: 'dev' },
    triggering_actor: { login: 'dev' },
    head_commit: { author: { name: 'Dev' }, message: 'Commit' },
    pull_requests: [],
    ...over,
  };
}

function job(steps, over = {}) {
  return {
    id: 1,
    name: 'Run Playwright tests',
    conclusion: steps.some((s) => s[1] === 'failure') ? 'failure' : 'success',
    started_at: '2026-10-13T03:30:10Z',
    completed_at: '2026-10-13T03:39:50Z',
    html_url: 'https://github.com/o/r/actions/runs/1001/job/1',
    steps: steps.map(([name, conclusion], i) => ({ number: i + 1, name, conclusion, status: 'completed' })),
    ...over,
  };
}

module.exports = { tmpDir, git, makeRepo, SPEC_V1, PAGE_V1, FIXTURE_V1, minimalRun, job };

const { defineConfig } = require('@playwright/test');
const { buildRunId, getTestCaseName, pruneOldReports } = require('./utils/reportRetention.js');

const MAX_REPORTS_TO_KEEP = 7;

// Every run gets its own "<TestCaseName>_<date>_<time>" folder for both the
// Playwright HTML report and the raw Allure results, instead of overwriting
// the previous run. Older runs beyond the retention limit are pruned so
// history builds up (up to 7 runs) without growing forever.
const testCaseName = getTestCaseName('./tests');
const RUN_ID = buildRunId(testCaseName);

const PLAYWRIGHT_REPORT_ROOT = 'playwright-report';
const ALLURE_RESULTS_ROOT = 'test-results/allure-results';
const ALLURE_REPORT_ROOT = 'allure-report';

// Prune to (limit - 1) before this run adds its own new folder, so the count
// tops out at the limit once the current run's report/results are written.
pruneOldReports(PLAYWRIGHT_REPORT_ROOT, MAX_REPORTS_TO_KEEP - 1);
pruneOldReports(ALLURE_RESULTS_ROOT, MAX_REPORTS_TO_KEEP - 1);

module.exports = defineConfig({
  testDir: './tests',
  timeout: 120000,

  fullyParallel: true,
  workers: process.env.CI ? 5:3,  // Jenkins vs Local
  retries: process.env.CI ? 1:0,

  use: {
    headless:  process.env.CI ? true :false, //Jenkins vs Local
    browserName: 'chromium',

    storageState: undefined,

    // Local runs use the maximized window; headless runs need an explicit size
    // or the site's responsive layout hides the header cart summary.
    viewport: process.env.CI ? { width: 1920, height: 1080 } : null,
    launchOptions: {
      args: [
        '--start-maximized',
        '--incognito'
      ],
    },

    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  reporter: [
    ['list'],
    // Machine-readable outcomes (per attempt, with retries) for the QA
    // Intelligence history; see qa-intel/README.md. Overwritten every run.
    ['json', { outputFile: 'qa-intel-output/playwright-results.json' }],
    ['html', { outputFolder: `${PLAYWRIGHT_REPORT_ROOT}/${RUN_ID}`, open: 'never' }],
    [
      'allure-playwright',
      {
        resultsDir: `${ALLURE_RESULTS_ROOT}/${RUN_ID}`,
        detail: true,
        attachments: true   // ⭐ IMPORTANT for logs + steps in Allure
      }
    ],
    [
      './utils/allureReportGenerator.js',
      {
        runId: RUN_ID,
        resultsDir: `${ALLURE_RESULTS_ROOT}/${RUN_ID}`,
        reportRoot: ALLURE_REPORT_ROOT,
      }
    ]
  ]
});










































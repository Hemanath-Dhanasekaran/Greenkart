const path = require('path');
const { execSync } = require('child_process');
const { pruneOldReports } = require('./reportRetention.js');

const MAX_REPORTS_TO_KEEP = 7;

/**
 * Returns a quoted command for the allure-commandline version pinned in
 * package.json, so local and CI runs produce the same report layout. The
 * launcher script is called directly because the package's npm wrapper
 * (`npx allure`) breaks on Windows when the project path contains spaces.
 * Falls back to an `allure` on PATH if the package isn't installed.
 */
function resolveAllureCommand() {
  try {
    const pkgDir = path.dirname(require.resolve('allure-commandline/package.json'));
    const script = process.platform === 'win32' ? 'allure.bat' : 'allure';
    return `"${path.join(pkgDir, 'dist', 'bin', script)}"`;
  } catch {
    return 'allure';
  }
}

/**
 * Playwright reporter that, once the run finishes, builds the browsable
 * Allure HTML report for this run's results into its own timestamped folder
 * (allure-report/<runId>) and prunes older run folders beyond the retention
 * limit. Runs regardless of pass/fail so a failed run still gets a report.
 */
class AllureReportGenerator {
  constructor(options = {}) {
    this.runId = options.runId;
    this.resultsDir = options.resultsDir;
    this.reportRoot = options.reportRoot || 'allure-report';
  }

  onEnd() {
    if (!this.runId) return;

    const reportDir = path.join(this.reportRoot, this.runId);

    try {
      // --single-file embeds all report data into index.html so it opens by
      // double-click; a multi-file report only loads through an HTTP server.
      execSync(`${resolveAllureCommand()} generate "${this.resultsDir}" --single-file --clean -o "${reportDir}"`, {
        stdio: 'inherit',
      });
    } catch (err) {
      console.warn(`⚠️ Could not generate Allure HTML report: ${err.message}`);
      return;
    }

    pruneOldReports(this.reportRoot, MAX_REPORTS_TO_KEEP);
  }
}

module.exports = AllureReportGenerator;

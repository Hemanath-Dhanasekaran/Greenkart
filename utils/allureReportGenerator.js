const path = require('path');
const { execSync } = require('child_process');
const { pruneOldReports } = require('./reportRetention.js');

const MAX_REPORTS_TO_KEEP = 7;

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
      execSync(`allure generate "${this.resultsDir}" --clean -o "${reportDir}"`, {
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

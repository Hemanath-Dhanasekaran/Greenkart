const fs = require('fs');
const path = require('path');

/**
 * Builds a stable, filesystem-safe run identifier of the form
 * "<TestCaseName>_<yyyy-MM-dd_HH-mm-ss>" using the current system date/time,
 * so every run gets its own report folder instead of overwriting the last one.
 */
function buildRunId(testCaseName) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const safeName = testCaseName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-');
  return `${safeName}_${timestamp}`;
}

/**
 * Resolves which *.spec.js file(s) under testsDir this run targets, preferring
 * whatever spec path(s) were passed on the CLI (e.g. `playwright test "tests/Foo.spec.js"`)
 * over the full list of spec files in the directory.
 */
function resolveTargetSpecFiles(testsDir) {
  const allSpecs = fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.js')).sort();

  const argSpecs = process.argv
    .slice(2)
    .filter((arg) => arg.endsWith('.spec.js'))
    .map((arg) => path.basename(arg));

  const matched = argSpecs.length ? allSpecs.filter((f) => argSpecs.includes(f)) : allSpecs;

  return (matched.length ? matched : allSpecs).map((f) => path.join(testsDir, f));
}

/**
 * Returns the title of the first `test(...)` (or `.only`/`.skip`/`.fixme`)
 * declaration in the given spec file, or null if none is found.
 */
function getFirstTestTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/\btest(?:\.only|\.skip|\.fixme)?\s*\(\s*(['"`])([\s\S]*?)\1/);
    return match ? match[2].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Returns the actual test case name (the title passed to `test(...)`) for the
 * spec file(s) this run targets, used as the "test case name" portion of the
 * report folder name. Falls back to the spec file's basename if no test title
 * can be found.
 */
function getTestCaseName(testsDir) {
  const targetFiles = resolveTargetSpecFiles(testsDir);

  for (const file of targetFiles) {
    const title = getFirstTestTitle(file);
    if (title) return title;
  }

  const first = targetFiles[0] || 'Test';
  return path.basename(first, '.spec.js');
}

// Matches the "<TestCaseName>_yyyy-MM-dd_HH-mm-ss" shape produced by buildRunId,
// so stray non-run directories (e.g. an old `allure-report/data` or `history`
// folder left over from a plain `allure generate`) are never mistaken for a
// report run when pruning.
const RUN_ID_PATTERN = /_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

/**
 * Keeps only the `maxToKeep` most recently modified run sub-directories inside
 * `dir`, deleting older ones. Used so report history builds up run-over-run
 * instead of being replaced, without growing forever. Only directories whose
 * name matches the run-id shape are considered; anything else in `dir` is left
 * untouched.
 */
function pruneOldReports(dir, maxToKeep) {
  if (!fs.existsSync(dir)) return;

  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_ID_PATTERN.test(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  entries.slice(maxToKeep).forEach((entry) => {
    fs.rmSync(entry.full, { recursive: true, force: true });
  });
}

module.exports = { buildRunId, getTestCaseName, pruneOldReports };

# QA CI/CD Intelligence Agent

Keeps a permanent, searchable history of this framework — test cases, framework
code, configuration, and every GitHub Actions run — and answers questions about
it in plain English:

```bash
npm run qa:ask -- "What tests were added this week?"
npm run qa:ask -- "What happened in the latest scheduled run?"
npm run qa:ask -- "Which commit introduced this failure?"
npm run qa:dashboard          # opens the dashboard in your browser
```

Everything is free and open-source: plain Node.js, a git branch for storage,
and GitHub Actions. There is no database, no server and no paid or AI service.
Answers come from deterministic queries over recorded facts. When a fact is
unknown, the answer says so instead of guessing.

---

## Contents

1. [How it works](#how-it-works)
2. [What is tracked](#what-is-tracked)
3. [Using it](#using-it)
4. [Asking questions](#asking-questions)
5. [The dashboard](#the-dashboard)
6. [How facts and inferences are kept apart](#how-facts-and-inferences-are-kept-apart)
7. [CI/CD integration](#cicd-integration)
8. [Storage, reliability and security](#storage-reliability-and-security)
9. [Limitations](#limitations)
10. [Development](#development)

---

## How it works

```
 Playwright Tests workflow (push / PR / daily 09:00 IST / manual)
   └─ runs tests as before (HTML + Allure reports, artifacts unchanged)
   └─ NEW: extract-results → qa-intel-results-attempt-N artifact (sanitised outcomes)
                │
                ▼  workflow_run: completed  (+ 6-hourly recovery sweep, + manual)
 QA Intelligence workflow
   └─ collect:  git history  → AST analysis → test / method / config change events
                GitHub API   → runs, jobs, steps, artifacts, results → run events
   └─ append new events to the qa-history branch (events/YYYY/MM/*.jsonl)
   └─ rebuild index/index.json + dashboard/index.html from all events
   └─ push (retrying safely if another writer got there first)
   └─ job summary + qa-dashboard artifact
                │
                ▼
 npm run qa:ask / qa:dashboard  (reads the qa-history branch)
```

| Piece | File |
| --- | --- |
| AST analysis of tests and symbols | `lib/jsAnalysis.js` |
| Repository snapshot and static call graph | `lib/snapshot.js` |
| Per-commit change detection | `lib/changes.js`, `lib/configDiff.js` |
| Test results (Playwright JSON / Allure) | `lib/results.js` |
| CI run classification | `lib/ci.js` |
| GitHub API client | `lib/github.js` |
| Collector | `lib/collector.js` |
| Event store and data branch | `lib/store.js` |
| Index, coverage and insights | `lib/indexer.js` |
| Questions → queries (also used by the dashboard) | `lib/query.js`, `lib/time.js` |
| Dashboard | `lib/dashboard.js`, `dashboard/` |
| CLI | `bin/qa-intel.js` |

## What is tracked

**Test cases** (`*.spec.js`). Each `test(...)` is tracked individually with:
- describe path, title, tags and modifiers (`skip`/`fixme`/`only`)
- assertions (`expect` chains), locators, `test.step` titles and fixtures
- Excel data usage, for example `sheetDataMap.get('Products')` and `EXCEL_ROWS = [14,15,20]`

Changes are classified as *added*, *modified*, *renamed*, *moved* or *deleted*.
Every test gets a **stable id** (`T…`) that survives renames and moves, so its
history and results stay connected.

**Framework code.** Covers functions, classes, methods, constructors,
`base.extend()` fixtures and spec-file hooks. Page objects, base page, helpers,
Excel and API utilities, reporters and the logger are each labelled by
category. Comparison is token-based, so edits to comments, JSDoc or formatting
never count as a code change. A constructor change also lists which locator
properties changed, for example `total: page.locator('.total') → page.locator('#cart-total')`.

**Configuration.** Covers these files:
- `package.json` (dependencies and scripts) and the lockfile
- `playwright.config.js` (settings and reporters)
- workflow files (triggers, jobs, steps, action versions)
- Excel workbooks: sheet, header and row numbers changed. Cell values are never stored.

**CI/CD runs.** Every completed run attempt of the *Playwright Tests* workflow
is recorded: push, pull request, schedule (with its cron) and manual. Each
record includes:
- trigger, commit, branch, actor, start and end time, duration
- jobs and steps
- per-test outcomes with retries and short sanitised errors
- links to the run and its Playwright HTML and Allure report artifacts, with expiry

A scheduled run is recorded even when no code changed.

## Using it

### In GitHub (automatic)

Nothing to do after the workflows are on `main`. After each *Playwright Tests*
run, the *QA Intelligence* workflow updates the history:
- The run's **job summary** shows the latest-run, weekly and coverage headlines.
- The **`qa-dashboard`** artifact contains the full dashboard as one HTML file. Download it and double-click.

To backfill or refresh at any time: **Actions → QA Intelligence → Run workflow**.

### Locally

```bash
npm ci
npm run qa:ask -- "Summarize this week's automation progress"
npm run qa:dashboard
```

Both commands fetch the `qa-history` branch into a git worktree at
`.qa-history/` (git-ignored) and read from it. Add `--offline` to skip the
fetch. Run `node qa-intel/bin/qa-intel.js help` for every option.

You can also collect locally, for example to try it on a fork:

```bash
# git history only, into a scratch folder (no push, no token)
node qa-intel/bin/qa-intel.js collect --store-dir ./tmp-history
node qa-intel/bin/qa-intel.js ask --store-dir ./tmp-history "what methods changed this week"

# include workflow runs (set GITHUB_TOKEN to also download test results)
node qa-intel/bin/qa-intel.js collect --store-dir ./tmp-history --api
```

Without a token, run records say *"results not captured … counts unknown"*.
They are never treated as passing.

## Asking questions

Questions are matched to a fixed set of queries:

| Ask about | Example |
| --- | --- |
| Test changes | "What test cases were added two days ago?" · "What tests were deleted this month?" |
| Method / framework changes | "What methods were added or modified yesterday?" · "What framework changes happened in the last seven days?" · "page object changes this week" |
| A run | "What happened in the latest scheduled run?" · "latest manual run" |
| Recent failures | "What tests failed in the last five executions?" |
| Cause of a failure | "Which commit introduced this failure?" · `why did "checks totals" fail` |
| Coverage gaps | "Which changed methods have not been covered by a successful relevant test run?" |
| A commit | "Show all QA activities for commit 5fb38c6" |
| Progress | "Summarize this week's automation progress" |
| Comparison | "Compare the latest scheduled run with the previous scheduled run" |
| Risks | "Which tests are flaky?" · "consistently skipped tests" · "show QA risks" |
| One test | `history of "Add products with quantities from Excel to cart @1"` |

**Dates** are interpreted in **Asia/Kolkata (IST)**, and every answer prints
the exact range it used:
- Weeks run Monday to Sunday.
- "last seven days" means today plus the 6 previous days.
- Explicit dates such as `2026-10-05`, `05/10/2026` (day first), `5 Oct` and `between … and …` all work.

**Filters** you can add: `scheduled` / `manual` / `push` / `pull request`,
`on branch <name>`, `by <author>`.

Use `--json` for the structured answer, or `--now <ISO time>` to anchor
"yesterday" to a fixed moment.

## The dashboard

The dashboard is a single self-contained HTML file. It works offline and needs
no server, in light or dark mode, at any screen width. It has these tabs:

| Tab | Shows |
| --- | --- |
| Overview | key numbers and the main conclusions first, plus data-completeness warnings |
| Ask a question | the same question engine as the CLI, with example questions |
| Activity timeline | commits and runs, newest first |
| Test cases | test changes, plus every test with its stable id, last result and pass rate |
| Framework changes | methods, classes, fixtures, config, dependencies, workflows and test data |
| CI/CD runs | every run with its classification, counts, failing tests and report links |
| Failures & risks | new failures and the commits around them, repeated failures, flaky, skipped, pipeline failures, coverage gaps |
| Trends | 30 days of runs by outcome and test changes, as a chart or table |
| Traceability | commit → changed code → linked tests → runs, and a method → test → run matrix |

Every list can be filtered by IST date range, branch, author, test file,
activity type and free text. Each record expands to show its evidence, links
and raw technical details.

## How facts and inferences are kept apart

- **Confirmed** facts are read directly from git or GitHub: commits, file diffs, test and method changes, run status, test outcomes.
- **Rename and move detection** is *confirmed* when the body is identical. It is marked *likely* when the title matches in another file, and *inferred* when the body is ≥ 80% similar. Otherwise the test is reported as added or deleted.
- **Test ↔ method links** come only from the **static call graph**:
  - test body and hooks → page-object instance (`homePage = new HomePage()`)
  - → method, including inherited ones → `this.x()` calls
  - fixtures used through test parameters

  Being in the same file never counts as a link.
- **Runner-level code** (`playwright.config.js` and the modules it loads, such as the Allure reporter), dependencies and workflows are marked as affecting *all* tests. This is inferred.
- **Coverage status** of each change:
  - `verified`: a linked test passed in a run on a commit that *contains* the change, using commit ancestry.
  - `failing`: linked tests ran there but did not pass.
  - `not-executed`: no such run with results yet.
  - `no-linked-tests`: no test reaches the code.
- **"Which commit introduced this failure"** lists the commits between the last passing run and the first failing run on the same branch. It ranks them by evidence: the test itself changed → changed code or data the test reaches → runner-level change → no link. The answer always says this is correlation, not proof. If both runs were on the same commit, it says no code change can explain the failure.
- **Flaky** is *confirmed* when Playwright reported a pass on retry, and *possible* when a test both passed and failed on the same commit.
- **Missing data is reported, never zeroed.** A run without captured results shows "counts unknown". A setup or `npm ci` failure is classified as a pipeline failure, never as a test failure.

## CI/CD integration

Changes to the existing pipeline. Everything existing is preserved: the Excel
tests, Playwright HTML report, Allure report and artifacts. There was no email
step to preserve.

| File | Change |
| --- | --- |
| `playwright.config.js` | added Playwright's built-in `json` reporter → `qa-intel-output/playwright-results.json` |
| `.github/workflows/playwright.yml` | added `pull_request` (to main) and a daily `schedule` (03:30 UTC = 09:00 IST) trigger; `permissions: contents: read`; two non-blocking steps (`continue-on-error`) that write and upload `qa-intel-results-attempt-N` (90-day retention) |
| `.github/workflows/qa-intel.yml` | **new** collector. Triggers: `workflow_run` + 6-hourly sweep + manual. Permissions: `contents: write` (only to push `qa-history`), `actions: read`, `pull-requests: read`. Serialised by a concurrency group. Always checks out the default branch's code, never PR code |
| `.github/workflows/qa-intel-selftest.yml` | **new** unit tests for this tool, run when `qa-intel/**` changes. Kept separate so tooling failures are never mistaken for test-suite failures |
| `package.json` | dev dependencies `acorn`, `acorn-walk`, `yaml`; `qa:*` scripts |
| `.gitignore` | `qa-intel-output/`, `.qa-history/` |

To drop the daily schedule or PR runs, remove those triggers from
`playwright.yml`. The history keeps working with whatever runs exist.

## Storage, reliability and security

The history lives on the orphan branch **`qa-history`** of this repository.
It shares no files with `main`, and pushes to it do not trigger the test
workflow.

```
qa-history/
  meta.json                         format + schema version
  events/YYYY/MM/<batch>.jsonl      append-only events (the source of truth)
  index/index.json                  derived — rebuildable with `qa-intel index`
  dashboard/index.html              derived
```

- **Duplicate prevention:** event ids are hashes of the event's natural key, such as commit sha + test key or run id + attempt. Re-collecting the same thing writes nothing.
- **Improving records:** a run first recorded without results (no token, download error) is replaced once results become available, using a ranked id. Records that are final are never rewritten.
- **Concurrency:** every collection writes its *own* new batch file, so writers never edit the same file. If a push is rejected, the collector resets to the remote head, re-applies its events (de-duplicated) and retries, up to 6 times with jitter. The workflow is also serialised by a concurrency group.
- **Interrupted jobs:** batch files are written atomically (temp file + rename), and partial lines are skipped and reported. The next run re-collects whatever is missing: it compares git history and the latest ~300 runs against the store.
- **Fresh runners:** nothing depends on runner storage or expiring artifacts. Run outcomes are copied into the history while the artifacts still exist.
- **Least privilege:** the test workflow is read-only. Only the collector job can write, and it pushes only to `qa-history`.
- **No secrets or sensitive data:**
  - Results keep only titles, outcomes, durations and the first 500 characters of error messages.
  - All text passes through redaction for tokens, keys, passwords, URL credentials, JWTs and private keys. An event that still looks sensitive is dropped.
  - Excel diffs store row numbers, never values.
  - No stdout, attachments, host names or e-mail addresses are stored.

Event format: see [SCHEMA.md](SCHEMA.md).

## Limitations

- **History begins** at the first commit (2026-10-12). For the 3 runs before this tool existed, results can only be recovered from their `allure-results` artifacts, and only while those exist (30-day retention). Retries for those runs are approximate.
- **Static analysis** follows the patterns this framework uses: `new Page()` instances, `this.method()`, `Class.staticMethod()`, required helpers and fixtures. Dynamic dispatch, computed property calls and `eval` are not followed. Unlinked code is reported as *no linked tests*, not as covered.
- **Commit time is used as the change time.** GitHub does not expose push time in git history.
- **PR branches** are analysed when CI ran on them. Commits that never ran in CI on an unscanned branch are not in the history.
- **GitHub limits:** `GITHUB_TOKEN` allows 1,000 API requests/hour per repository. A collection uses about 5 requests plus about 4 per new run. Large backfills are spread over several sweeps (`--max-runs`, default 60).
- **A data branch** suits years of history for a repository this size; events are a few KB per commit or run. If it ever grows past roughly 100 MB, move `qa-history` to a separate private repository and change `--branch`/remote. The format does not change.
- **The question engine is rule-based.** Questions it cannot match fall back to keyword search plus a list of supported questions. An optional AI layer could rephrase answers, but it is deliberately not included, so nothing depends on a paid service.

## Development

```bash
npm run qa:test     # 42 unit/integration tests (node:test, no browser, no network)
npm run qa:verify   # integrity check of the qa-history branch
```

The tests build throwaway git repositories and a fake GitHub API. They cover:
- test discovery and individual test matching
- add / modify / rename / move / delete detection
- method changes, with comment-only edits ignored
- IST date ranges
- duplicate prevention and rank upgrades
- persistence on fresh clones, forced push races and parallel writers
- CI classification, including missing and incomplete results
- intent routing for every example question
- commit → method → test → run traceability
- deterministic index rebuilds
- dashboard data embedding

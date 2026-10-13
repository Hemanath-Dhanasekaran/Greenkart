# QA history event schema — version 1

Each line of `events/YYYY/MM/*.jsonl` on the `qa-history` branch is one JSON event:

```json
{
  "schemaVersion": 1,
  "id": "evt_3f9c…",            // sha256(type | repo | naturalKey), first 24 hex chars
  "type": "test.added",
  "occurredAt": "2026-10-13T11:12:28.000Z",  // commit time, or run completion time (UTC)
  "recordedAt": "2026-10-13T16:06:59.120Z",
  "rank": 1,                     // only ci.run uses >1; the higher rank wins for the same id
  "source": "git" | "github-actions",
  "collectorVersion": "1.0.0",
  "repo": "owner/name",
  "data": { … }                  // depends on type, below
}
```

## Rules

- **Ids are deterministic.** The same fact always gets the same id, and readers keep one event per id.
- **Ranked replacement.** If two events share an id, the one with the higher `rank` wins. On a tie, the later `recordedAt` wins. `ci.run` ranks:
  - 1 = results missing for a retryable reason
  - 2 = results definitively missing
  - 3 = results present
- **Append-only.** Files are never edited. A newer, better event is written to a new batch file.
- **Version checks.** Readers reject events whose `schemaVersion` is newer than they support, and report them as invalid instead of misreading them.
- **Adding fields** is a compatible change. Removing or renaming fields requires a schema version bump and a migration note here.

## Common commit fields

These appear in every `test.*`, `code.*` and `config.changed` event, and in `commit.recorded`:

| field | meaning |
| --- | --- |
| `sha`, `shortSha` | commit |
| `branch` | branch the commit was collected from |
| `author` | git author name. E-mail addresses are never stored |
| `authorLogin` | GitHub login, if known |
| `committedAt` | ISO time with offset |
| `pullRequests` | `[{number, title, url, state, merged}]`. `[]` means none; `null` means it was not looked up |
| `links` | `commit`, plus `file` (source at that commit, with a line anchor) |

## Types

### `commit.recorded` — natural key `sha`

| field | meaning |
| --- | --- |
| `parents` | parent shas, used for ancestry |
| `authoredAt` | author time |
| `subject` | first line of the commit message |
| `files` | `[{path, oldPath, status, category, note}]`. `note` explains comment-only or unparseable changes |
| `counts` | `{files, testChanges, testsAdded, testsDeleted, codeChanges, configChanges}` |

### `test.added | test.modified | test.renamed | test.moved | test.deleted` — key `sha|type|testKey|previousKey`

| field | meaning |
| --- | --- |
| `test` | `{key, title, titlePath, file, line, tags, modifiers}`. `key` is `"<file>::<describe> > <title>"` |
| `previous` | the test before a rename or move |
| `details` | lists of what was added and removed: `assertions`, `locators`, `steps`, `methodCalls`, `elementRefs`, `tags`, `modifiers`, `fixtures`. Also `testData {before, after}` and `bodyChanged` |
| `summary` | short human-readable lines |
| `evidence` | `{basis, confidence: confirmed / likely / inferred, similarity?}` |

### `code.added | code.modified | code.renamed | code.deleted` — key `sha|type|symbolId|previousId`

| field | meaning |
| --- | --- |
| `symbol` | `{id, kind, name, qualifiedName, className, file, category, line, params}`. `id` is `"<file>#<Class.method>"`. `kind` is function, method, constructor, getter, setter, class, fixture or hook |
| `previous` | the symbol before a rename or move |
| `details` | `signature`, `locators`, `calls`, `properties` (constructor `this.x =` assignments), `superClass`, `bodyChanged`, `sizeTokens` |
| `impact` | `{scope: linked / global / none, reason, tests: [{testKey, evidence: static-call, via, chain}]}` |
| `evidence` | as for tests |

### `config.changed` — key `sha|file`

| field | meaning |
| --- | --- |
| `file`, `previousFile`, `status` | the file and how it changed |
| `category` | dependencies, playwright-config, ci-workflow or test-data |
| `details` | structured diff:<br>• package sections<br>• lockfile counts<br>• flattened config keys<br>• workflow triggers, jobs and steps<br>• Excel sheets with changed, added and removed row numbers |
| `summary` | short human-readable lines |
| `impact` | `global`; or, for Excel, the tests that reference the changed rows or sheets |

### `snapshot.baseline` — key `sha`

Written when collection starts part-way through a repository's history. It lists the tests and symbols that already existed at that commit.

### `ci.run` — key `runId|attempt`

| field | meaning |
| --- | --- |
| identity | `runId`, `attempt`, `runNumber`, `workflow {id, name, path}` |
| trigger | `event`, `isScheduled`, `scheduleCron` |
| commit | `branch`, `sha`, `title` |
| people | `actor`, `triggeringActor`, `commitAuthor` |
| `pullRequests` | linked PRs |
| timing | `createdAt`, `startedAt`, `completedAt`, `durationSec` |
| outcome | `status`, `conclusion` |
| `classification` | see below |
| `jobs` | `[{id, name, conclusion, startedAt, completedAt, url, steps: [{number, name, conclusion, stage}]}]` |
| `tests` | test results, see below |
| `reports` | `{runUrl, playwrightReport, allureReport, allureResults, qaIntelResults, artifacts: […]}`. Each artifact has `{name, id, url, expiresAt, expired}` |

**`classification`** is `{category, label, failureStage, failedStep, testsExecuted, notes}`:
- `category`:
  - success: `passed`, `passed-with-flaky`
  - test failures: `tests-failed`, `tests-step-failed`, `tests-step-failed-no-results`
  - failed before tests ran: `setup-failed`, `dependency-install-failed`, `browser-install-failed`
  - failed after tests: `reporting-failed`, `history-failed`
  - other failures: `failed-unknown-stage`, `infrastructure-failure`, `workflow-error`
  - incomplete: `succeeded-results-missing`, `cancelled`, `timed-out`
  - not run: `skipped`, `other`
- `testsExecuted` is `true`, `false` or `"unknown"`.

**`tests`** is one of:
- `{available: true, source: playwright-json | allure-results, fidelity: full | partial, counts, playwrightStats, globalErrors, results: […]}`
- `{available: false, reason, counts: null}`. Missing results are never zero.

Each entry of `results` has:
- `key`, `file`, `title`, `titlePath`, `project`, `tags`
- `outcome`: passed, failed, flaky, skipped, timedOut, interrupted or notRun
- `retries`, `durationMs`
- `attempts: [{retry, status, durationMs}]`
- `error: {summary, message, location}`, sanitised and truncated

## Results file (`qa-intel-results-attempt-N` artifact)

Written inside the test job by `qa-intel extract-results`:

```json
{ "format": "qa-intel-run-results/1", "generatedAt": "…",
  "github": { "runId", "runAttempt", "sha", "ref", "event", "workflow", "job", "schedule", "testsStepOutcome" },
  "results": { …same shape as ci.run `tests`… } }
```

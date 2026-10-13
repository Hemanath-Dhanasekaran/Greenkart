# QA Intelligence history

Machine-written history of test, framework and CI/CD activity, maintained by
`qa-intel/bin/qa-intel.js collect` (see qa-intel/README.md on the main branch).

- `events/` — append-only JSONL event batches (source of truth, never edited)
- `index/index.json` — derived index, rebuilt from events on every write
- `dashboard/index.html` — self-contained dashboard built from the index

Do not edit by hand. Delete `index/` and run `qa-intel index` to rebuild it.

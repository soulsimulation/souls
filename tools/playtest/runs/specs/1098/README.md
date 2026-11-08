# S3 live arms (#1098)

The specs behind #1098's arms, kept so anyone can run one from main. The declarations, arms' commits and results are on #1098.

| Files | Use |
|---|---|
| `s3-<entry>-dry` | scripted-owner seats, no model. Checks that the harness and a server still work together. Their seats act in words, so `act.not-an-id` there says nothing about a live seat. |
| `s3-<entry>-live-sonnet` | the baseline arm. World cap from its cast's `rails`. |
| `s3-<entry>-candidate-sonnet` | the candidate arm: the same casts with `worldBudgetUsd` 0.75. |
| `s3-<entry>-remeasure-sonnet` | the candidate's casts, scored with the v3 questions. |

Entries: `steer-refuse`, `reasonable-actions`, `sustained-intent`.

**Scorer pin.** The arms so far were scored by `tools/playtest/runs/controllability.mjs` at sha256 `c1ed74affb40a5656275492d1d99e653b4419ad270dbaea643aafbc3cea4cde6`. A run stamps the hash it was started with, and its card says `predeclared: true` only if that hash still matches at evaluation. A scorer change means a new version and a new arm: don't compare a card across hashes. Those arms stay at version 3; version 4 (#1276) supersedes it for later arms, and a card re-evaluated across versions reads `predeclared: false`.

**Run one, no model:**

```bash
node tools/playtest/runs/run.mjs start tools/playtest/runs/specs/1098/s3-steer-refuse-dry.json --out .local/s3-dry
node tools/playtest/runs/run.mjs evaluate .local/s3-dry
```

**Run a live arm** (Sonnet only, needs the coordinator's go-ahead, on a quiet playtest machine, at most $1 per world per rolling 24 h, declared with hashes on the issue first):

```bash
PLAYTEST_SPECS="tools/playtest/runs/specs/1098/s3-steer-refuse-remeasure-sonnet.json tools/playtest/runs/specs/1098/s3-reasonable-actions-remeasure-sonnet.json tools/playtest/runs/specs/1098/s3-sustained-intent-remeasure-sonnet.json" \
  bash tools/playtest/cloud/run-replay.sh <server-branch> <out-name> 2
```

`tools/playtest/cloud/run-specs.sh` runs them in order, one at a time, with the stops in its header. Before anything is committed to `playtest-results`, the results are copied for the branch, and on that copy `tools/playtest/cloud/publish-scrub.mjs` removes seat folders, world data, binaries and links, replaces machine details, and drops any file that still fails the publication check. If it fails, nothing is published. The run's own folder on the machine keeps its world data and seat folders (#1311). `run.mjs compare` and `scorecard.json` in each run's `evaluations/` read the result.

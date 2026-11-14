# Testing

Souls has five layers of checks. Run the cheapest one that proves your change, and let the proof tier decide what a PR
needs.

| Layer | What | Where it runs |
|---|---|---|
| Unit and typecheck | `node --test` suites per package, `tsc` per package | your machine, CI |
| Gates | walk, bundle, conformance | your machine (focused), CI, the remote gate |
| Browser e2e | the local smoke (`node e2e/local-smoke.mjs`) and Markdown scenarios against an isolated client fixture | your machine, CI |
| Remote gate | the complete suite for a release head: CI's result at the exact commit for the steps CI runs, Modal for the rest | the release workflow |
| Playtests | coding agents play Souls and gods in a fake-mind world, reviewed by agents | a quiet machine or a cloud session |

All of them use fake minds and isolated data directories. None touches production.

## Unit tests and typecheck

```sh
pnpm typecheck                               # every package (tsc --noEmit)
pnpm --filter @souls/server test               # one package
node --test apps/server/src/god/buildsafe.test.ts   # one file
pnpm test:mars                               # the vendored engine's deterministic suite
pnpm test:client                             # the client-eval suite (the legacy client's tests no longer run, #1754)
pnpm test                                    # everything (slow; prefer the focused forms)
```

In CI, every god-skill unit test (each `*.test.mjs` under `tools/god-skill/`, its `lib/`, `scripts/` and `e2e/`, the
replay corpus among them; none needs a browser or a live server) runs on the `server-0` job (`godSkill` and
`GOD_SKILL_TESTS` in `.github/scripts/ci-scope.mjs`), which any `apps/server/` or `tools/god-skill/` change selects.

The Pip authoring example's renderer test is manual, not part of CI: it needs pulled media and loads renderer code
with parameter properties, so run `node --experimental-transform-types --test tools/body-authoring/robot/robot.test.mjs`
when you change `tools/body-authoring/robot/` or the humanoid renderer it fits.

`pretest` checks that the media the tests read is in place (`pnpm assets:pull` fixes it). Server tests run with
`--test-concurrency=1`. Prefer `node --test` on the files you touched while iterating; the full suite belongs to CI
and the remote gate.

## Walk gate

Walkability is a release invariant. `apps/server/src/god/walk-audit.ts` audits fixed fixture copies of several worlds,
a fresh genesis and a generated fuzz world (every building type at several yaws and grounds, packed, furnished,
stacked and nested), and the gate fails when any place is worse than `tools/test-harness/walk/baseline/`: more
destinations a Soul cannot walk to and back, more one-way links, more goalless things, or floating things.

```sh
node tools/test-harness/walk/walk.mjs                       # audit and compare (about a minute)
node tools/test-harness/walk/walk.mjs --world fuzz,bench-hamlet
node tools/test-harness/walk/walk.mjs --write               # accept a deliberate change as the new baseline
node tools/test-harness/walk/walk.mjs --from <gate out>/candidate/out/suite/walk --write
```

The fixtures are part of the `test` media set (`pnpm assets:pull --set test`). A baseline change, better or worse, is
its own reviewed commit before the final gate.

## Bundle gate

`tools/test-harness/bundle-budget/` measures the web build's code chunks (keyed by name without the content hash, raw
and gzip) against the reviewed `baseline.json`. It fails when a chunk or the total grows by 10 % or more beyond a small
slack, or when a large new chunk appears.

```sh
node tools/test-harness/bundle-budget/budget.mjs --build --check     # build apps/web, compare, exit 1 on offenders
node tools/test-harness/bundle-budget/budget.mjs --build --write     # accept a deliberate change
```

The gate never writes the baseline; only a reviewed commit does.

The comparison runs in two places: the CI job `types-web`, on the build it already makes, so growth fails `ci-ok` on the
PR that causes it; and V3-bundle in the release gate. A PR that changes only the baseline or the budget tool also selects
`types-web`.

## Replay corpus

Old history must keep its meaning. `apps/server/test/fixtures/replay-corpus/` holds frozen event logs from fake-mind
worlds recorded in a temporary database (never production): a toy world, a green-field god world with world-edits that
adopts the boot runtime-policy chain at its first boot, and a Mars campus world with decisions, a body assignment and a
retire that adopts the chain mid-history, so it has pins before and after. Each entry is `<name>.log.json.br` (the world
row, every event, one snapshot; never rewritten) and `<name>.pins.json` (its reader, the policies its log adopts, and
the state and kernel hashes at a few ticks and at its head). `apps/server/src/replay-corpus.test.ts` refolds every log
with the current engine from genesis at each pinned tick, and boots it as a restarting server does, from genesis and from
its snapshot, to the head. It runs in the server CI shards, which engine, fold, kernel and protocol paths select.

A runtime policy adopted at boot (`adoptBootRuntimePoliciesV1`) is prospective: a log recorded before its adoption has
no rules event for it and must refold to the same pins. A pin that moves means a change reached history that never
adopted it: ship it as a logged rules fact or a documented reader instead.

```sh
node apps/server/test/fixtures/replay-corpus/record.ts <name> --recipe <toy|god-greenfield|mars-campus>   # add a log
node apps/server/test/fixtures/replay-corpus/record.ts --check            # compare every entry's pins with this tree
node apps/server/test/fixtures/replay-corpus/record.ts --write <name|all> # re-pin a deliberate change from the frozen logs
```

When a new boot-adopted policy merges, add an entry recorded after it under a new name (for example
`mars-campus-2 --recipe mars-campus`); the older entries, recorded before it, and their pins stay as they are. A
`--write` re-pin is its own reviewed commit with its reason, like the walk and bundle baselines. Logs are never
re-recorded: the recorder refuses an existing name.

## Conformance

`packages/conformance` bakes, places and furnishes every core library def revision at its parameter endpoints and
checks its geometry budgets. Known failures are pinned by exact def hash in `packages/conformance/conformance/*.json`.
A change that alters a def revision fails until a new supplement in that folder re-pins its documented tuples, in the
same change, with the reason in its note and in the folder's README. Never edit an older supplement.

```sh
pnpm --filter @souls/conformance test
node packages/conformance/bin/conformance.mjs --shard 1/4 --out .local/conformance-1.json   # bounded sweep
```

## Browser e2e

The quick proof that the app works is the local smoke: one command boots an isolated instance (fake minds, dev
sign-in, a data dir under `.local/e2e/`) on a free port, opens the world list and one world in headless Chromium,
checks that a person is drawn with no console errors and no failed requests, writes `summary.json` and screenshots
under `.local/e2e/<timestamp>/`, and stops everything it started.

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" pnpm --filter mars-campus-viewer exec playwright install chromium   # once
node e2e/local-smoke.mjs --build                 # any free port; --port N or E2E_PORT=N to choose; --clip for a video
```

[testing/e2e.md](testing/e2e.md#local-smoke) has its checks, output and exit codes. The other scenarios in
`e2e/scenarios/` drive an isolated client fixture and write a proof bundle under `.e2e/runs/`; the `e2e` repo skill
runs and authors them. Rendering diagnostics for camera follow and temporal stability are in `tools/render-checks/`.
The engine's own browser tests are in `mars/viewer/e2e/`.

## CI window

Per-PR CI (`ci.yml`) shares GitHub's hosted-runner cap, about 20 concurrent jobs. A server change selects about ten
heavy legs, so with several workers pushing, unready PRs used to starve the merge path. Pull request runs are
therefore **windowed**:

- **Every PR push** runs the cheap jobs, `scope` and `repo` (the tooling tests), and the separate `security` (gitleaks,
  path-guard, scrub-guard), `proof` and `changelog` workflows.
- **Heavy jobs** (the `qualify` matrix and the browser `smoke`) run only inside the window: the PR is not a draft
  and carries `merge:ready` or `ci:run`. Outside the window, a run whose paths selected heavy jobs is **deferred**.
  The heavy jobs are skipped and `ci-ok` fails with "Full CI deferred". A deferred `ci-ok` is a real failure, so
  skipped heavy jobs never count toward merging, and branch protection still requires a green `ci-ok`. Docs or
  tools-only PRs select no heavy jobs and are never deferred.
- **To request full CI**, add `ci:run` (or `merge:ready`) to a ready PR. `ci.yml` takes the `labeled` event, so that starts
  a fresh `pull_request` run with the window open. The merge queue reads required checks from that event: a green dispatch
  doesn't clear a deferred `ci-ok`. The run queues behind a CI run already going for the same PR and cancels nothing, and it
  does no heavy work if that run passes at the same head, or if the head's newest run already passed. Once a PR is in
  the window, its later pushes run in full as usual. A PR with conflicts gets no `pull_request` run until they are fixed.
- **Any other label starts the same run** (#2018). The merge queue reads only the newest `ci` run at a head, so a run
  without `ci-ok` would hide the real one. Like a window label's run, it queues behind the PR's running CI, cancels
  nothing, and does no heavy work when the head's newest run passed, so its `ci-ok` repeats that result.
- **By hand**, `gh workflow run ci.yml --ref <branch> -f pr=<n>` runs a PR's path-scoped CI on its branch, on the branch's
  own `ci.yml`. It tells you the result, but it doesn't count for the queue.
- Pushes to main, manual runs without `pr`, and merge-group runs are never windowed. Main keeps its full-scope runs,
  which the merge train reads (see CI on main below). A merge-group run is path-scoped over everything in the group since `main`, and
  `proof-ok` reports there without checking anything, because a PR passes it at its head to enter the queue.

Steward procedure: give `ci:run` to the PRs entering the window, normally the next two in merge order. Add
`merge:ready` once a head's `ci-ok` is green, and remove `ci:run` from PRs that leave the window. A PR labelled
`merge:ready` straight from a deferred head still works: the labeled run replaces the deferred one, and the train reads
the replaced failure as stale (#909). But the train's 15-minute head wait is shorter than a server run, so a PR that
is behind main can still leave with `needs:rebase`. The decision is `windowFor` and `windowed` in
`.github/scripts/ci-scope.mjs`.

**CI on main.** The merge queue fast-forwards `main` to the commit its merge-group run tested, so the push carries
the same sha. When a successful merge-group `ci` run at that sha passed every `qualify` job, the push run does no heavy
work: it runs `scope`, `repo` and the marker job `merge-group-covered`, and `ci-ok` passes on those. Any other push to
main (a direct push, a revert, a merge group whose paths selected only some jobs) runs everything. The marker counts as
full scope for the merge train's `fullScope`, and the release gate's CI evidence then reads the merge-group run's jobs.
The decision is `queueCovered` in `.github/scripts/ci-main.mjs`.

**Soul Action tests.** `tools/soul-actions/*.test.mjs` runs as the CI job `soul-actions`, about 76 s measured on a
loaded laptop. It is picked by its own paths (`tools/soul-actions`, `apps/server`, `packages/world-compiler`,
`packages/engine-*`) and by every full-scope run, including each push to main, and a failure blocks through `ci-ok`. It
is not a gate step, so the gate's suite tree and cached baseline don't change.

**Soul runtime and trace tests.** `tools/soul-runtime/*.test.mjs` and `tools/soul-trace/*.test.mjs` run as the CI job
`soul-tools`, about 17 s measured on a loaded laptop. It is picked by its own paths (`tools/soul-runtime`,
`tools/soul-trace`, `tools/world-launcher/soul`, `apps/server`) and by every full-scope run, and a failure blocks through
`ci-ok`. Like `soul-actions`, it is not a gate step.

**Self-hosted runners.** The `qualify` legs that `ci-scope.mjs` marks `heavy: true` (the server shards and the legs
whose hosted median is over about 8 minutes: `packages`, `launcher`, `soul-actions`) run on the runners named by the
repository variable `CI_HEAVY_RUNNER` when it is set (one label, such as `souls-ci`, or a JSON array of labels). Every
other leg, and every leg while the variable is unset, runs on GitHub-hosted runners, so one run uses both pools at
once. The browser `smoke` leg and the `native` leg always stay GitHub-hosted: `native` has a wall-clock budget that a
loaded shared host misses (#1162). One runner instance takes one job at a time, so routing is only worth it with several
instances online; a leg moves between pools by its flag, and `ci-scope.test.mjs` pins the split. `tools/ci/setup-runners.sh` sets them up on one Linux host, run there as root: N instances, each a
systemd service under one dedicated unprivileged user, with the label, and Playwright's Chromium system packages when
the OS has them (not Ubuntu 20.04). It is idempotent, takes the registration token as an argument and names no host;
its header shows the one-line invocation from a workstation. The steward sets and clears `CI_HEAVY_RUNNER`.

## Remote gate

[testing/remote-gate.md](testing/remote-gate.md): `tools/test-harness/release-gate.sh` qualifies the complete suite for a
candidate: the steps CI ran identically at that commit come from CI, the rest run on Modal and are compared with the
baseline. Clean means 0 new failures, 0 blockers and 0 unexpected skips.
The release head always takes the full scope; candidates may use `--scope auto`. The baseline comes from a cache, and
docs/tools-only changes are never gated ([Modal policy](process/modal-policy.md)). A PR that removes or renames a test
the gate compares adds its `tools/test-harness/renames.json` entry in the same change, and a newly skipped test its
`quarantine.json` entry; CI's `repo` job checks both ([renames](testing/remote-gate.md#renames)).

## Capacity qualification workflow

`.github/workflows/capacity-qualify.yml` runs the meetup bench (`tools/bench/capacity/meetup/meetup.mjs`, CW1/CW2)
on a self-hosted runner. It is manual only, and one run at a time. The runner's labels come from the
`QUALIFY_RUNNER` repository variable, a JSON array such as `["self-hosted","<neutral label>"]`; the default is
`["self-hosted"]`. Keep labels, the runner name and the machine name neutral, because the public job log prints the
runner and machine names. Someone with write access dispatches it with `ref` set to a branch that carries the bench.
`ref` must be `main` or one `agent/<name>` branch of this repository; tags, commit SHAs and any other branch are
refused before checkout. Until #791 and #793 merge, the bench is on `agent/736-hardware-qualification`:

```bash
gh workflow run capacity-qualify.yml -f ref=<branch> -f quiet_host=true \
  [-f profile=even,meetup] [-f repeats=2] [-f short=false] [-f browser=false] [-f slice_cpu_quota=400%] [-f slice_memory_max=8G] \
  [-f active_min=60] [-f telemetry=true]
```

- **Quiet.** The bench gets `--quiet-host --qualifying-executor` only when four things hold: the dispatcher sets
  `quiet_host`; the Actions API shows no other job in progress on the same runner set; no other Soul server
  process runs on the host; and the host's 1-minute load per core settles below 0.25 within 5 minutes. Otherwise the
  run still measures, but it is labelled not-quiet, and every failing reason is recorded. The same checks run again
  after the bench. If they fail then, the artifact's `VERDICT.md` carries a "not quiet after the fact" banner.
  Before dispatching, turn off anything else that can use the runner, such as the `CI_HEAVY_RUNNER` variable.
- **Nothing shared between runs.** The runner is persistent and the bench ref's code runs on it, so pnpm itself,
  its store, cache and state, the media cache and any Chromium download live in a per-run directory under the job's
  temp dir, and the last step deletes it. No step uses `actions/cache`. Each run therefore downloads its packages and
  the web and runtime media again.
- **Browser.** The bench's real browser (`--browser`: one headless Chromium holding world 0's page) is off by default
  (`browser=false`). Browser-dependent measurements need a host that already has Playwright's Chromium system
  libraries: the workflow downloads Chromium but never installs system packages (no `--with-deps`, no sudo). The
  default self-hosted runner does not have them, because Playwright cannot install them for its OS, so leave
  `browser` off there; if Chromium cannot start, the bench records the browser as unavailable.
- **Allocation.** `slice_cpu_quota` and `slice_memory_max` run the worlds inside a `systemd-run --user --scope` with
  those limits, and the run is refused if the host cannot apply them. Without them the allocation is the runner's
  own cgroup. A memory limit it does not set leaves headroom unknown, so the verdict cannot be `passes`.
- **Artifact** `capacity-qualify-<run id>`. It holds `VERDICT.md`, `summary.json` and `qualify.json` (the quiet
  decision and its facts), plus each run's `REPORT.md`, `receipt.json` and `result.json`. Workspace, home, host and
  user names are replaced with placeholders. The upload is refused if a file holds a Soul token. `souls/`,
  `launcher/` and logs never leave the runner and are deleted at the end of the job.
- **Slopes (CW7, #741).** `profile=slopes`, alone, runs `tools/bench/capacity/slopes/slopes.mjs` instead, with
  `--cpu-prof`; see the bench README's "Slopes" section. The ctl script comes from the workflow's own commit, so until
  this lands on `main`, dispatch the workflow from the branch that carries it (`gh workflow run … --ref <branch>`).
  The artifact holds the top-level `REPORT.md`, `receipt.json` and `results.json`, plus each arm's `result.json`. The
  calls, live samples, CPU profiles, templates and `souls/` stay on the runner.
- **Long windows (CW8 A2, #955).** `active_min` sets the activity window, from 20 to 240 minutes; blank means 20. It is refused unless `(minutes + 15) × runs ≤ 280`, so the run fits the job's 300 min: for example, `profile=meetup repeats=1 active_min=60`. `telemetry=true` runs the launcher's collector beside the worlds. Each run's `result.json` carries `growth`, the trends after an explicit warm-up; see the bench README's "Long windows" section.
- **What it qualifies.** The host is the maintainer's machine. Its verdict is labelled with `host_class` and is not
  a production-class result unless that host is the production class.

## Playtests and the swarm director

- [testing/playtests.md](testing/playtests.md): batteries, personas and casts play Souls and gods as coding-agent
  seats in a fake-mind world; Reviewer and Developer passes produce findings and scorecards. Measure on a quiet
  machine, two repeats per arm. [testing/playtests-cloud.md](testing/playtests-cloud.md) runs them in a cloud session.
- [testing/swarm-director.md](testing/swarm-director.md): `node tools/playtest/playtest.mjs direct <cast>` directs
  several Souls live from a cast file; the `souls-director` skill does it from a chat session.
- How to run and judge them: [process/playtest-method.md](process/playtest-method.md).

## What to run when

| Change | Run before the PR |
|---|---|
| Docs, tools only | links resolve; the tool's own tests if it has them |
| Server or package logic | `node --test` on touched files, `tsc -p` of touched packages |
| Anything that can move geometry, navigation or god builds | add the walk gate |
| Web app | `pnpm --filter @souls/web build`, the bundle gate, the local smoke, an uncut clip of the changed journey |
| Library defs, generators, compiler | `library.test.ts` and `catalogue-checks.test.ts` (budgets and holds), conformance, plus a supplement when a revision changes |
| Soul behaviour, navigation, engines | the above plus a scenario playtest with two repeats per arm |
| Release head | the remote gate, then the release workflow (live walks and cdn-walk) |

Don't re-run a check that passed on the same tree.

## Proof tiers

A PR's tier comes from the paths it changes, mapped in [process/PROOF-POLICY.yml](process/PROOF-POLICY.yml);
`node tools/proof/tier.mjs` prints the tier of your diff, and a `tier:Tn` label can raise it. In short: T0 (docs,
tools) needs lint; T1 (logic) focused tests and typecheck; T2 (visible behaviour) adds an uncut real-speed clip on a
fake-mind world; T3 (Soul behaviour, navigation, engines) adds a scenario playtest, a reviewer pass and maintainer
sign-off; T4 is the release head. "Done" means walked on the real URL with real input
([agent lifecycle](process/agent-lifecycle.md)).

### Recording a proof clip on a GPU runner

When the local machine is busy, record the clip on a `souls-timed` runner with its GPU: write a clip kit in
`tools/proof/clips/<kit>/` (`kit.json` with the template, viewport and any `localStorage` such as
`{"sim.dev": "admin"}`, and `steps.mjs`; `_shared/cast.mjs` makes Souls and a god agent and keeps them listening),
push it to an `agent/` branch, then dispatch the timed run from that branch:

```bash
gh workflow run timed-run.yml --ref agent/<kit-branch> -f command=clip -f ref=agent/<pr-branch> -f args='--kit <kit>'
gh run download <run-id> -D .e2e/clip-<run-id>
node tools/proof/upload.mjs --pr <n> .e2e/clip-<run-id>/clip/<kit>-desktop.mp4
```

The kit and the recorder come from the workflow's branch, the app from `ref`. The recorder runs with
`SIM_PROOF_GPU=hardware`: it fails (exit 5) rather than fall back to SwiftShader, and the log and the sidecar's `gl`
name the renderer. The log also prints the clip's frame timing (frames, mean fps, largest gap) beside the take's wall
clock. The job holds no write token, so the clip comes back as the run's artifact and `upload.mjs` attaches it.

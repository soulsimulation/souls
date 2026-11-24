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

### The Soul client file

`tools/world-launcher/soul/eden.mjs` is served and copied as one file, so `inline.mjs` inlines the client's modules
(the `MODULES` it lists: `soul/*.mjs` and `packages/form-rules/src/rules.ts`) into generated blocks of it. **A pull
request does not carry the rebuilt file.** Edit the module (or eden.mjs's own code outside the blocks) and leave the
blocks as they are, so two PRs that change form rules never collide on eden.mjs. Who builds it:

- **CI**: every `qualify` job runs `node tools/world-launcher/soul/inline.mjs` before its checks, so PR, merge-group
  and main runs test the client built from that head. A module that cannot be inlined fails the job, and the launcher
  test `inline: inline.mjs builds eden.mjs from its modules` checks the same locally.
- **Main**: `eden-sync.yml` runs after each push to main that touches a module. When the committed copy is stale it
  opens one pull request carrying only the rebuilt file (branch `bot/eden-sync-<sha>`, labelled `merge:ready`), so
  checkouts, tools and local worlds that read eden.mjs from git catch up within a queue cycle.
- **Stamp**: the same sync pull request stamps the client when it changed since the last release
  (`release-client.mjs stamp`), and release.yml refuses a head whose copy is stale or unstamped (`release-client.mjs
  check`), so the client a world serves
  (`/eden.mjs`, and `upgrade` on users' machines) always matches the rules the release runs.

Locally, run `node tools/world-launcher/soul/inline.mjs` before running tests that load eden.mjs after a module
change. Then leave the rebuilt blocks out of your commit: `git checkout tools/world-launcher/soul/eden.mjs` when you
did not edit eden.mjs's own code, or `git add -p` it when you did. `inline.mjs --check` says whether a copy is
current.

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
node tools/test-harness/walk/walk.mjs --keep                # keep each audit's walk-audit-* scratch world copy
```

Each audit copies its world into a `walk-audit-*` folder in the temp directory and removes it when it exits, also
after a failure or a kill (a detached watcher removes a killed audit's copy); `--keep` keeps it (`WALK_KEEP=1` for
`walk-gate.test.mjs`).

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
retire that adopts the chain mid-history, so it has pins before and after. Each entry is `<name>.log.json` (the world
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
runs and authors them. Rendering diagnostics for camera follow and temporal stability are in `tools/render-checks/`; `strobe.mjs` there
holds the camera still and fails on any region that flips between frames (#1265).
The engine's own browser tests are in `mars/viewer/e2e/`.

## CI window

Since 0.132 (task F1), **every push to a ready (non-draft) pull request runs `ci` once, with no label**:

- **A ready PR** runs `scope`, `repo`, the light `qualify` legs its paths pick and the browser `smoke`, plus the
  separate `security` (gitleaks, path-guard, scrub-guard), `proof` and `changelog` workflows. Labels start no run.
- **A draft** runs `scope` and `repo` only. When its paths select heavier jobs, `ci-ok` fails as "Full CI deferred"
  until it is marked ready for review, which starts a full run. Docs or tools-only drafts are never deferred.
- **The merge queue runs no test again; it compiles the group.** A PR enters only with its required checks green at
  its head, so a `merge_group` run of `ci` skips `scope`, `repo`, `qualify` and `smoke`. Two PRs green alone can still
  combine into code that does not build, so `group-check` compiles the combined code: `cargo check --workspace
  --all-targets --locked` of `v2/` and `tsc --noEmit -p apps/web`, each only when the group changed what it builds
  from (`groupChecks` in `.github/scripts/ci-scope.mjs`). It runs on the self-hosted pool with its toolchain and cargo
  target kept per runner, and `ci-ok` waits for it. The push to main that lands it runs its paths' light set; that,
  the daily full run and the remote gate are the net after merging.
- **`proof-ok` and `fragment` never block.** Both report success on every PR and merge group: no proof tier, journal
  entry, maintainer sign-off or changelog fragment is required. `fragment` logs a warning for a malformed fragment.
- **The full battery runs daily at 06:23 UTC and before each release, not per change** (Gene, 18 Nov: startup mode,
  merge no slower than lanes implement). No `pull_request` or push run runs the `qualify` legs that `ci-scope.mjs`
  marks `heavy: true` (`packages`, which includes the walk, the `launcher-*` legs, the server shards and the
  `soul-actions-*` legs). They run in the daily scheduled run on main (see CI on main below), in a manual run, and in
  the remote gate before every release. The step summary lists the legs left to the daily run. The decision is
  `lightOnly` in `.github/scripts/ci-scope.mjs`.
- **Kinds' case files run only when they can change.** The `kinds` leg runs `tools/entry/*.test.mjs` and the
  form-rules tests over `packages/form-rules/cases`. Only a change under `content/kinds/`, `packages/form-rules/` or
  `tools/entry/` picks it; a full-scope diff (the lockfile, `.github/`, an unmapped path) does not (`pathsOnly` in
  `ci-scope.mjs`). The daily full run always runs it.
- **By hand**, `gh workflow run ci.yml --ref <branch> -f pr=<n>` runs a PR's path-scoped CI on its branch, on the branch's
  own `ci.yml`, heavy legs included. It tells you the result, but it doesn't count for the queue.

**Low-risk paths.** When every file a PR or a merge group changes sits under `tools/entry/`, `content/kinds/`,
`content/asks/`, `content/moves/`, `packages/form-rules/`, `docs/`, `changes/`, or is a root `*.md` other than
`AGENTS.md` and `CLAUDE.md`, CI skips the server shards, `latency`, the smoke, `packages` (the walk) and `types-web` (the
bundle). It runs `repo`, `soul-tools` (the one launcher test that reads `content/kinds`, among others), `kinds` (the
entry tests and the form-rules tests) and, for `docs/site` reference pages, `docs-reference`. A change under `packages/form-rules/src/` also
keeps `types-web` and `web`, because `apps/web` imports it. One file outside the list, or an empty or unreadable diff,
and the usual path map decides; a changelog fragment beside other files selects nothing itself (since 21 Nov; before,
it read as an unmapped path and every PR with a fragment ran every job). `content/kinds` and `content/moves` also run
the v2 legs, which load them. The list is
`LOW_RISK` in `.github/scripts/ci-scope.mjs`. The push to main after a merge selects the same light set.

To merge, enqueue the PR: `gh pr merge <n> --squash` (add `--auto` to enqueue once its checks are green), or label it
`merge:ready` for the merge train, which does the same. The decision is `windowFor` and `windowed` in
`.github/scripts/ci-scope.mjs`.

**CI on main.** A push to main runs the light set its paths pick. Push runs
share one concurrency group, `ci-main`, and a newer push cancels an older one still running, so when merges land
quickly only the newest main commit is tested. The full battery, every leg, runs once a day on main: the scheduled run
at 06:23 UTC (`schedule` in `ci.yml`), in its own group, `ci-daily`, which nothing cancels. A manual run
(`gh workflow run ci.yml --ref main`) is full scope too. Main's CI blocks nothing: the merge queue doesn't read it. A
red daily run gets a same-day fix lane. Cancelled runs say nothing. The merge train's `mainCiState` (used only when the
merge queue is off) reads the newest completed full run, daily or manual, and a red light push after it still counts.
The release gate's CI evidence takes the fullest successful run at the exact candidate: a daily or manual run on main,
then a push, then a merge group. A candidate with only a light run there leaves the heavy steps to the remote gate,
which runs everything before a release. Until 18 Nov a push covered by a full merge-group run ran the marker job
`merge-group-covered` instead; `ci.yml` no longer has it, and readers accept the marker only on those older runs
(`.github/scripts/ci-main.mjs`).

**Soul Action tests.** `tools/soul-actions/*.test.mjs` runs in four parallel CI legs, `soul-actions-0` to `-3`, about
10 minutes each on hosted runners (one file, `shared-bay.test.mjs`, has a leg to itself). The launcher's unit tests
(V3-launcher-unit) run the same way in three legs, `launcher-0` to `-2`, each file one at a time as before.
`.github/scripts/test-legs.mjs` splits each directory listing by the seconds per file measured on one hosted run
(`test-leg-durations.json`); a missing or stale entry only unbalances the legs, never drops or repeats a file. The
Soul Action job is picked by its own paths (`tools/soul-actions`, `apps/server`, `packages/world-compiler`,
`packages/engine-*`) and by every full-scope run, but it is a `heavy: true` leg, so since 18 Nov it runs only in the
daily run on main and in manual runs. It is not a gate step, so the remote gate doesn't run it, and the gate's suite
tree and cached baseline don't change.

**Soul runtime and trace tests.** `tools/soul-runtime/*.test.mjs` and `tools/soul-trace/*.test.mjs` run as the CI job
`soul-tools`, about 17 s measured on a loaded laptop. It is picked by its own paths (`tools/soul-runtime`,
`tools/soul-trace`, `tools/world-launcher/soul`, `apps/server`) and by every full-scope run, and a failure blocks through
`ci-ok`. Like `soul-actions`, it is not a gate step.

**Engine v2 (`v2/`).** Five parallel CI legs build and test the Rust workspace under `v2/` with `v2/tools/ci.sh <leg>`,
on the toolchain `v2/rust-toolchain.toml` pins, with a cargo cache keyed on that file and `v2/Cargo.lock` (every leg
restores it; `v2-rust` saves it on a miss); they skip the pnpm install. `v2-rust` runs format, Clippy, the small checks
and every package's tests but sim's and worldd's; `v2-sim` and `v2-worldd` run those two packages' tests; `v2-wasm` the
WASM build against the native answers; `v2-client` the client and page tests against the built binaries, among them
the served-world gate (`v2/client/served/e2e/world.test.mjs`): a served Eden slice, two paired Souls acting through
the thin command, the page's worker on the public stream and the client's copy, across a restart. Its assertions that
wait on an open fix run under a named `PENDING #<issue>` marker: printed while they fail, and failing the run once
they pass, so the fix's PR removes the marker. Together they
run exactly what `ci.sh` with no argument runs, and `ci-ok` needs each leg that ran. Each leg is picked by its own
inputs (`V2_PATHS` in `.github/scripts/ci-scope.mjs`), in pull request and merge group runs alike, and every leg by a
full-scope run. `v2/crates`, `v2/tools`, the files at `v2/`'s root and `content/kinds`, `moves` and `worlds` run all
five. A change only under `v2/client` or `v2/web` runs `v2-rust` (its origin tests import both) and `v2-client`, plus
`v2-sim` for `src/hatch` and `v2-wasm` for `v2/client/src/history`; `v2/docs` runs none but `docs/site` (the client's
MCP page, `v2-client`). When in doubt a path runs the leg. A change only under `v2/` runs v2 legs
alone, has release-gate scope `none` (no walk, bundle, conformance or remote gate) and is T1, its docs included. The
strict tiers for the core (`v2/crates/sim`, `replica`, `skills` T3; `v2/web` T2) are written in
`docs/process/PROOF-POLICY.yml` and switched on at the cut-over by X8 (#2839). The publication check and the secret
scanner always apply. Later tasks add their steps to a leg in `v2/tools/ci.sh`, not new jobs.

<a id="pre-push-quick-check"></a>**Pre-push quick check.** Before pushing a `v2/` change, run `v2/tools/ci.sh quick`
(about a minute warm): `cargo fmt --check`, the `no-kind-names` rule and Clippy with warnings as errors on the crates
the branch changed against its merge base with `origin/main` (uncommitted and untracked files included;
`V2_QUICK_BASE` names another base). A change to the workspace `Cargo.toml`, `Cargo.lock`, `clippy.toml` or the
toolchain file lints the whole workspace. It is not a CI leg and replaces none: it exists so a three-second rule
never costs a CI run. A crate whose dependents break is still CI's catch.

**Served-world end-to-end (being added).** The served-world e2e CI test (`ci/served-world-e2e`, its own lane) runs a
representative Eden world through the real pairing and join path on every v2 PR and checks real Soul actions (walk,
sit, gesture, say and whisper, a malformed word, a restart) against the public stream and the client's copy. With a
full-Eden served smoke on every release head, it is the gate for what no unit test reaches: a real body through the
world loop to the public stream.

**Self-hosted runners.** The `qualify` legs that `ci-scope.mjs` marks `heavy: true` (the server shards and the legs
whose hosted median is over about 8 minutes: `packages`, `launcher-*`, `soul-actions-*`) run on the runners named by the
repository variable `CI_HEAVY_RUNNER` when it is set (one label, such as `souls-ci`, or a JSON array of labels). Every
other leg, and every leg while the variable is unset, runs on GitHub-hosted runners, so one run uses both pools at
once. The browser `smoke` leg and the `native` leg always stay GitHub-hosted: `native` has a wall-clock budget that a
loaded shared host misses (#1162). One runner instance takes one job at a time, so routing is only worth it with several
instances online; a leg moves between pools by its flag, and `ci-scope.test.mjs` pins the split. `tools/ci/setup-runners.sh` sets them up on one Linux host, run there as root: N instances, each a
systemd service under one dedicated unprivileged user, with the label, and Playwright's Chromium system packages when
the OS has them (not Ubuntu 20.04). It is idempotent, takes the registration token as an argument and names no host;
its header shows the one-line invocation from a workstation. The steward sets and clears `CI_HEAVY_RUNNER`.

**Wide runner (D5).** One more timed instance, `souls-wide-1` with the label `souls-wide`, runs on the timed-runner host.
Its service is pinned (systemd `CPUAffinity=`) to the union of the CPUs of `souls-timed-3` to `souls-timed-6`: 12
physical cores, so the world gets 6, the launcher 1 and the load drivers 5. It is for the gates only: V7 (5,000 viewers)
and H1 at 5,000 or more. Dispatch `timed-run.yml` with `runner=souls-wide` and a core plan, for example
`-f runner=souls-wide -f cores=world=6,launcher=1 -f command=viewers -f args='--viewers 5000,10000'`. It takes the split
commands, which need a core plan there, and `settled`. Viewer arms above 2,000 are refused on every other runner.
- **Soft mutex.** The wide instance shares its CPUs with four narrow ones, and the start gate keeps them apart. Each run
  waits up to 5 minutes for its own CPUs to go quiet and then refuses. On `souls-wide` the gate also refuses while any
  one of its CPUs is over half busy, so a wide job does not start on top of a narrow one.
- **If they race.** A narrow job's gate sees only its own CPUs, and a wide run leaves some of them nearly idle (most of
  the world's cores), so a narrow job can start during a wide run. Both then run on shared cores and neither timing
  counts; repeat the wide run. For a gate run, keep narrow jobs off those four: remove their `souls-timed` label for the
  run and add it back after (`gh api -X DELETE repos/soulsimulation/souls/actions/runners/<id>/labels/souls-timed`, then
  `gh api -X POST repos/soulsimulation/souls/actions/runners/<id>/labels -f 'labels[]=souls-timed'`; the ids come from
  `gh api repos/soulsimulation/souls/actions/runners`).
- **Set up or change it** with `tools/ci/setup-runners.sh --count 1 --prefix souls-wide --label souls-wide --cpus-from
  souls-timed-3,souls-timed-4,souls-timed-5,souls-timed-6`, run as root on the host. Run it with `--dry-run` first: that
  prints the CPUs it read from each instance and every step, and changes nothing.
- **Remove it.** On the host, in its install directory: `sudo ./svc.sh stop && sudo ./svc.sh uninstall`. Then delete its
  `<unit>.d` drop-in under `/etc/systemd/system`, run `sudo systemctl daemon-reload` and delete the directory. Finally,
  delete the runner on GitHub (`gh api -X DELETE repos/soulsimulation/souls/actions/runners/<id>`).

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

## A hundred worlds at once (#2301)

`tools/bench/capacity/hundred/hundred.mjs` demonstrates the still-worlds tranche (#2241) end to end through the
checkout's own launcher, fake minds, every file under its `--out`. It builds the fixture (100 small `hello-hamlet`
worlds and 4 `eden-2026` worlds, one or two Souls each, booted once from genesis and stopped), then: every world's agent
acts at seeded gaps of 2 to 10 minutes for an hour with world memory for about 25 small worlds (A6); all agents stop
together and every listening world has a reminder due at one shared instant, then a crawler fetches every page (A7);
every world should unload (A3); one world listens with a reminder inside the gap (A5); after an hour, one act each to a
sleeping Soul in a small and an Eden world (A4); and for three sampled worlds a twin, the fixture's start state ticked
straight through (`SIM_SKIP=0`) over the world's own log, must reach the state hash the jumped world wrote (A2). A8 is
worked out by hand from its report.

Run it on a `souls-timed` runner through the timed-run workflow (command `hundred`; the report, `results.json` and the
log are the artifact; Soul folders and world data stay on the runner):

```bash
gh workflow run timed-run.yml -f command=hundred -f ref=<branch> -f args='--short'                 # A9: under 20 min, 6 + 1 worlds
gh workflow run timed-run.yml -f command=hundred -f ref=<branch> -f args='--fixture-only'          # A1 alone: build the 104 worlds
gh workflow run timed-run.yml -f command=hundred -f ref=<branch> -f args='--short --small 3 --eden 1 --active-min 4'
```

`--short` uses short knobs, stated in the report: agents act every 0.5 to 1.5 minutes for 6, the wind-down is shortened
with `SIM_BODY_KNOBS` (silent 1 minute, walked out within 2; dev worlds only), a still world unloads after 1 quiet
minute instead of 10, and the gap is 3 minutes. The full run (no `--short`: 60 active minutes, the real one-hour
wind-down, a one-hour gap) takes about three and a half hours; the timed-run job allows `hundred` 270 minutes (every
other command keeps 120). A piece of the tranche the checkout lacks (`/__sim/still`, the jump and its counters, the
wind-down, the load queue, `--worlds-mem-mb`) is listed under "Missing from this checkout" with its issue, and the
parts that need it are reported as not shown, never as passed.

## The 0.132 check (F5)

`node tools/release/check-0132.mjs` checks 0.132's "Done when" lines 2 to 4 on a local Eden on the new engine. Eden runs
behind the local front door (`v2/tools/ops/proxy/soul-game.caddy` with the run's addresses) and is switched with
`tools/world-launcher/v2-switch.mjs`. Local only, fake minds, its own folder under `.local/check-0132/`.

```sh
node tools/release/check-0132.mjs --bin <release worldd, gatewayd, directoryd, driver> --pkg <replica wasm package> \
  --card <v2/web build> [--mars-web <mars/viewer/dist/client>] [--facts <eden facts>] [--agents 100] [--seconds 600] \
  [--only 2,3,4] [--keep]
```

- **2.** A fresh agent pairs at `/pair` (the served client, approved in a real browser) and then walks, sits, lies,
  takes, carries, puts down, says and gestures. Each step must show on the old page within 2 s. One uncut clip of the
  page goes to `clip/`.
- **3.** `--agents` seeded Souls are driven by the driver (`loads.mjs mix-<n>-even-every4`, `--trace`). It counts:
  - intents never answered;
  - acts not answered within 10 s;
  - pairs of bodies closer than 0.3 m in two chunks running, sampled on the page.
- **4.** A browser smoke of home, sign-in, sound, music and the camera.

It prints a pass/fail table and writes `report.json` and `table.md`. Exit 0 when every line passes. The browser uses
the first of the proof recorder's GPU flag sets (ANGLE Metal on macOS; ANGLE Vulkan, ANGLE GL-EGL, EGL on Linux) whose
`WEBGL_debug_renderer_info` names a hardware renderer; with none, or `--gl soft`, lines 3 and 4 run on SwiftShader and
line 2 is not reported.

On the shared build machine, with its GPU, one command provisions everything in the run's own directory (node 22,
pnpm install, media, the old page and the character set, Playwright's Chromium, the release builds and replica's WASM,
the new page, caddy), runs the check and removes the run's world folders and checkout after:

```sh
gh workflow run timed-run.yml --ref main -f command=check-0132 -f ref=main -f args='--agents 100 --seconds 600 --only 2,3,4'
gh run download <run-id> -D .local/check-0132-<run-id>   # report.json, table.md, check.log, clip/*.webm
```

The table is also in the run's summary.

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
| Engine v2 (`v2/`) | `v2/tools/ci.sh quick` before each push; the touched crate's or client's tests |
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
`{"sim.dev": "admin"}`, and `steps.mjs`), push it to an `agent/` branch, then dispatch the timed run from that branch.
The runner brings up the ref's old page on a new-engine world of the template
(`tools/playtest/arena/new-engine/old-page.mjs`, built in the job); `_shared/cast.mjs` pairs the kit's Souls through
the new client, names them and joins them, and its `walk`, `actOn` and `find` act by words in a Soul's own copy. A kit
whose verbs have no new-engine form yet (rides, the television: 0.135 K4) carries `skip` in its kit.json, saying why,
and the runner refuses it by name:

```bash
gh workflow run timed-run.yml --ref agent/<kit-branch> -f command=clip -f ref=agent/<pr-branch> -f args='--kit <kit>'
gh run download <run-id> -D .e2e/clip-<run-id>
node tools/proof/upload.mjs --pr <n> .e2e/clip-<run-id>/clip/<kit>-desktop.mp4
```

The kit and the recorder come from the workflow's branch, the app from `ref`. The recorder runs with
`SIM_PROOF_GPU=hardware`: it fails (exit 5) rather than fall back to SwiftShader, and the log and the sidecar's `gl`
name the renderer. The log also prints the clip's frame timing (frames, mean fps, largest gap) beside the take's wall
clock. The job holds no write token, so the clip comes back as the run's artifact and `upload.mjs` attaches it.

The page with many Souls ([#2554](https://github.com/soulsimulation/souls/issues/2554)) is measured the same way:
`-f command=page -f args='--souls 12,50,200,500 --shape event' -f repeats=2 -f cores=world=1` runs
`tools/test-harness/page-souls.mjs`, which grows one fake-mind Eden 2026 to each size with raw Souls on a load shape
and records frame time, draws, GPU time, heap and long tasks for desktop and phone, Broadcast and a high Free view. Its
`REPORT.md` holds the table; the frame times are relative to the runner's GPU, not a visitor's.

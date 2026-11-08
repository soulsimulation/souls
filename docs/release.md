# Releasing Soul

How the version lines relate and what a release carries: [versioning](process/versioning.md).

## Release owner

The development coordinator is the release owner (maintainer decision, 2026-11-06). It runs each release end to end:
the gate receipt for the exact head, `ship.sh` with its backups, the post-ship checks (healthz, walks, cdn-walk),
rollback on failure, the changelog and the GitHub Release. Production deletes still need the maintainer's explicit
yes. If a permission classifier refuses a step, the coordinator reports the exact step, the workaround it tried and
the exact command for the maintainer to run; it never hands back silently. One owner holds an active release head;
lanes and the repo steward don't deploy or run paid gates.

## Current production topology

The canonical site is `https://soul.game`, with production built and launched at base `/`; `souls.game` redirects
to it. Internal service/data names stay `sim-*`. There is no second public legacy stage on this host.
A release is one command, [`ship.sh`](#shipsh), run from a clean checkout of the exact commit. It sets
`SIM_WORLDS_BASE=/`, so the sealed build and launcher base match. The release workflow is not qualified for this
topology yet (draft [#523](https://github.com/soulsimulation/souls/pull/523), tracked by
[#519](https://github.com/soulsimulation/souls/issues/519)): it still runs the historical dual-stage command, so **do not
dispatch it on the root-only host**. Do not start a new gate to compensate for a missing receipt without authorization.

## Historical dual-stage deployment

This section and [`ship-dual-stage.sh`](#ship-dual-stagesh-historical) describe the old host. Current production does not use them.

A release puts one exact commit on its target host. The historical deployment uses two launcher **stages**, each a
`sim-worlds@<stage>` systemd unit running the world launcher under its keeper (`tools/world-launcher/keeper.mjs`):

| Stage | Serves | Build id | Release directory on the host |
|---|---|---|---|
| `production` | `https://sim.eden.art/worlds/` (every world people create) | `we-<sha12>` | `/srv/sim-worlds/releases/we-<sha12>` |
| `legacy` | `https://sim.eden.art/` and `/w/<key>` (the original worlds) | `we-<sha12>-root` | `/srv/sim-old/releases/we-<sha12>-root` |

Both stages ship from the same commit in the same release. A `staging` stage (loopback only, dev auth) also exists
in `release.sh`; ship.sh does not use it. See [operations](operations.md) for the services themselves and
[the runbook](operations/runbook.md) for day-to-day commands.

## Release order

1. **Gate receipt.** The candidate commit has a clean full-scope receipt from the
   [remote gate](testing/remote-gate.md) (`tools/test-harness/release-gate.sh`), combined with the V7 browser walk
   into a ship receipt (`tools/test-harness/ship-receipt.mjs`). Clean means no new failures, no blockers and no
   unexpected skips. A scoped candidate gate (`--scope auto`) is useful during development but never makes a ship
   receipt.
2. **Build exactly HEAD of a clean tree.** `release.sh` refuses uncommitted tracked changes and ships `git archive
   HEAD`, so the build id names exactly what runs.
3. **CDN first.** Any new immutable asset the web build's CDN manifest references is uploaded to `assets.eden.art`
   and verified before the release ([CDN](operations/cdn.md)). The client falls back to the origin on a CDN miss,
   but a release must not depend on that.
4. **Staged ship.** `tools/world-launcher/deploy/ship.sh` takes a read-only snapshot, stages without activating, boots a
   copy of every world's database with the staged tree (the rehearsal), makes row-verified backups, starts the live
   probe and does one guarded reload, in that order (below).
5. **healthz.** Each activation checks the stage's `/__sim/healthz` reports the new build and every registered world
   answers; afterwards `https://soul.game/__sim/healthz` shows `build`, `worlds`/`running` and `hostOk`.
6. **Walks.** Real-Chrome arrivals on desktop and phone, the poster and stall checks.
7. **cdn-walk.** `tools/cdn/cdn-walk.mjs` proves the live pages load mapped assets from the CDN.
8. **Rollback on failure.** A failed handover or health check rolls back on its own; any later failure stops the run
   and prints the exact rollback commands. Code is rolled back; data never is.

## The release workflow

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs [`ship.sh`](#shipsh) on a GitHub runner,
started by manual dispatch on `main`. A `release` concurrency group lets only one run (or gate) at a time. Inputs:

| Input | Default | Meaning |
|---|---|---|
| `version` | required | Release version for the changelog and tag, such as `4.17`; also ship.sh's `--label` |
| `dry_run` | **true** | `ship.sh --no-switch`: every step for real except the backup and the activation, checked against the build that stays live. Stage skips `install.sh`, so the host's unit files and timers stay as they are. No receipt is needed and publish does not run. The label is `<version>-rehearsal`. The staged release directory and its dependencies stay on the host; a later real ship of the same build reuses them. It deletes nothing on the host except the rehearsal's own scratch directory, which it created |
| `date` | today (UTC) | The release date compiled into the changelog page and `CHANGELOG.md`. The page is part of the web build, so a real ship on a later day than its dry run of the same head must pass the dry run's date, or the staged build differs and stage refuses to overwrite it |
| `accept_host_codes` | none | ship.sh's `--accept-host-codes`, such as `halted` for a release that fixes a halted world |
| `eyes` | **laptop** | Where the browser checks (probe, walks, poster, stall) run. `laptop`: on a GPU workstation with [`ship/eyes.mjs`](#the-workstations-eyes), handed over by commit status, and ship.sh runs `--no-eyes`. `runner`: on the GitHub runner, as before; it has no GPU, so they fail there (below) |
| `receipts` | `receipts-v<version>` | A GitHub release holding the head's publishable `release-receipt.json` |

```sh
gh workflow run release.yml --ref main -f version=4.17                    # dry run: nothing goes live
gh workflow run release.yml --ref main -f version=4.17 -f dry_run=false   # the release
# then, on the GPU workstation, with the dispatched head and run id (the run's summary prints this line):
node tools/world-launcher/deploy/ship/eyes.mjs --sha <head, 40 hex> --run <run id> --label 4.17
```

Its jobs:

1. **preflight**: the required secrets and variables exist (it names any that are missing), the head is `main`, the
   tag does not exist yet, the inputs are sane.
2. **ship**: in the `production` environment (limited to `main`). It installs, pulls media, installs Chromium at a
   known `PLAYWRIGHT_BROWSERS_PATH`, builds the Mars web overlay (`MARS_WEB_SRC`: the viewer's static site from this
   commit plus the static manifests, Draco decoders and campus model from the public origin), writes the probe god
   folder from `SIM_PROBE_GOD_JSON`, and for a real ship downloads the receipts and combines them
   (see below). Then `ship.sh --label <version> --sha <head>` (with `--no-switch` for a dry run). Its output
   is filtered so no IPv4 literal is printed; the host itself is a secret, so the log masks it.
   With `eyes=laptop` the job waits up to 20 minutes for the workstation's probe before ship.sh, and up to 45 minutes
   for its verdict after it. Both waits fail closed: no pass, no publish. A stop once the host activation began (other than
   the host's own refusal) is reported as "live state unknown", with the rollback command. A real ship whose browser checks then fail is
   live; the summary prints the [rollback](#rollback-without-ssh) command.
3. **publish** (real ships only): compiles `changes/` into [`CHANGELOG.md`](../CHANGELOG.md), tags `v<version>` on
   the shipped commit and creates the GitHub Release.

**Receipt.** The workflow runs no gate: one full gate per head runs through `gate.yml` or the laptop, and the V7 walk
needs real Chrome on a GPU, which the runner lacks. The raw gate and V7 receipts carry device paths, so they never
leave the machine. The release owner derives the publishable release receipt from them. It holds only shas, the build
id, statuses, counts, timestamps and the sha256 of each raw receipt, and `ship-receipt.mjs` refuses to write it unless
it passes the publication check. The ship job checks it again, and ship.sh's preflight verifies it for the exact head
(`root-release.mjs receipt`). The host is masked in every log even when `SIM_DEPLOY_HOST` is a variable.

```sh
node tools/test-harness/ship-receipt.mjs receipt.json v7-receipt.json --public release-receipt.json
gh release create receipts-v4.17 --prerelease --title "receipts 4.17" release-receipt.json
```

**Evidence.** The run's artifact `ship-<label>` holds only result files that pass `tools/proof/publication.mjs`
(`STEPS.txt`, `POSTLIVE.txt`, `ship-result.json`, `rehearse.json`, the check verdicts). `ship.log` and the raw logs
stay on the runner, since tools tee'd into them can name the host. The step summary shows `ship-result.json`.

The historical dual-stage command (`ship-dual-stage.sh`) is no longer run by the workflow.

### The workstation's eyes

The GitHub runner has no GPU, so Chrome draws WebGL in SwiftShader, and the browser bars measure the emulator, not the
release (#1438). The first 4.17 dry run on the runner drew the stall page at about 2.7 fps, with 8 gaps over 1 s; the
laptop drew about 2300 frames with a 200 ms worst gap against the same live build. Phone arrivals took 15 to 43 s
there against 2 to 3 s. The same laptop with `--disable-gpu` and SwiftShader fails stall the same way. So the probe,
the walks, the poster and the stall run on a GPU workstation, over plain HTTPS, with exactly ship.sh's commands and
`checks.mjs`'s bars. They need no ssh.

`ship/eyes.mjs --sha <sha> [--run <id>]` and the ship job meet through commit statuses on the release sha
([`ship/handover.mjs`](../tools/world-launcher/deploy/ship/handover.mjs)). Every description carries the run id, so a
status from an earlier run or attempt never counts (`<run>` is `<run id>.<attempt>`, since a re-run keeps the id):

| Who | Context | State and description | Meaning |
|---|---|---|---|
| job | `release/ship` | pending `run=<run> mode=<ship\|no-switch> waiting-for-eyes` | about to run ship.sh `--no-eyes` |
| eyes | `release/eyes` | pending `run=<run> ready` | the probe is watching (expecting `we-<sha12>`, or the live build for a dry run) |
| job | `release/ship` | success `run=<run> released`, or failure `run=<run> stopped: …` | activated (or skipped it, `--no-switch`), or stopped before |
| eyes | `release/eyes` | success `run=<run> pass`, or failure `run=<run> fail: <checks>` | the verdict |

While it waits, eyes re-posts `ready` every minute and fails at once if its probe exits. Right before the activation,
ship.sh's `SHIP_PREACTIVATE_CMD` checks that the newest `release/eyes` status for the attempt is `ready` and under
3 minutes old; otherwise nothing goes live. If the `released` status cannot be posted after a real
activation, the job records it, retries once and goes on; it never reports that as "before the release". Status
details are reduced to `[A-Za-z0-9 ()=.,:_-]`, so no path or stack trace reaches GitHub; a failed probe names the bar
items it missed, such as `probe(noBuild=2)`.

Eyes refuses a run whose head is not `--sha`, or that is not `release.yml`. It skips an earlier run's or attempt's
waiting status and keeps looking. A failure, an interrupt or a crash posts
`fail`, never `pass`, and lets the probe stop and remove its edits first. A ship that stops before the release fails eyes without walks. Outputs, `probe/report.json`
included, go to `.local/ship/<label>-eyes/`, with the bar alone in `probe-bar.json`. With `eyes=runner`, the run's
artifact carries `probe-bar.json` too.

### Rollback without ssh

```sh
gh workflow run rollback.yml --ref main -f build=<we-previous> -f from=<we-live> [-f dry_run=true]
```

[`rollback.yml`](../.github/workflows/rollback.yml) runs in the `production` environment, in its own
`rollback` concurrency group, so it never queues behind a release's verdict wait. It runs [`deploy/rollback.sh`](../tools/world-launcher/deploy/rollback.sh), which does exactly what
ship.sh's `ROLLBACK.txt` says: the previous release's own `activate.sh production <dir> --reload`, then public healthz
on that build with every registered world. It refuses, changing nothing (exit 80), unless the live build is `from`,
the host's `production.previous` is `build`, and `releases/<build>` is staged. When the host is already on `build` it
only verifies. It never touches a backup, a database, the registry, auth or host settings, and it deletes nothing.

The site's public changelog page (`<base>/changelog`, currently `https://soul.game/changelog`) is `CHANGELOG.md`
rendered into the web build (`apps/web/changelog.html`, `apps/web/src/changelog-page.ts`). So that the page shows the
release being shipped, the ship job first compiles the shipped fragments into a copy outside the tree
(`tools/changelog/compile.mjs --out`) and the build renders that copy (`SIM_CHANGELOG_FILE`); the tree stays exactly
HEAD. Publish then writes the same section, with the same date from preflight, into the committed `CHANGELOG.md`. A
laptop `ship-dual-stage.sh` run renders the committed `CHANGELOG.md` unless you set `SIM_CHANGELOG_FILE` the same way.

Configuration lives in GitHub, never in the repository; preflight names whatever is missing:

| Name | Kind | Purpose |
|---|---|---|
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | repository secrets | the remote gate (`gate.yml`) |
| `SIM_DEPLOY_HOST`, `SIM_DEPLOY_USER` | variables (or secrets) | SSH target of the production host |
| `DEPLOY_SSH_KEY`, `SIM_DEPLOY_KNOWN_HOSTS` | `production` environment secrets | SSH key and the host's known-hosts entry |
| `SIM_PROBE_GOD_JSON` | `production` environment secret | god file of the release-probe world; the ship job refuses to run without it |
| `SIM_ORIGIN` | optional variable | public origin, default `https://soul.game` |
| `MODAL_CLIENT_VERSION` | optional variable | pip pin for the Modal client |

Outside the workflow, the scripts read the same variables from the environment or from an untracked `deploy.env` at
the repository root (copy [`deploy.env.example`](../deploy.env.example); the environment wins). Loaders:
`tools/world-launcher/deploy/deploy-env.{sh,mjs}`.

## ship.sh

```sh
tools/world-launcher/deploy/ship.sh --label <version> --sha <full sha> [--dry-run | --no-switch] [--from <step>] [--out <dir>] [--accept-host-codes <code,...>]
```

It asks nothing: ssh runs in batch mode, and it never prompts. Before the release is live, any failure stops the run.
Afterwards, a failed check is recorded and the later checks still run, so the owner decides with all the evidence.

| Option | Meaning |
|---|---|
| `--label <version>` | The release, such as `4.16`. Names the output folder and the backups (`pre-r416-production-<time>`). |
| `--sha <full sha>` | The commit to ship. It must be HEAD of a clean tree and an ancestor of `origin/main`. |
| `--dry-run` | Prints every step and its commands. Nothing remote is touched and nothing is written. Exits 1 when a guard would stop a real run. |
| `--no-switch` | Runs every step for real except the backup and the activation: snapshot, stage, rehearse, the probe (expecting the live build), healthz of the live build, walks, poster, stall and cdn-walk. Nothing goes live, so there is nothing to back up or roll back. `host-activate.sh` never runs, and stage skips `install.sh` (`SIM_RELEASE_NO_INSTALL=1`), so no unit file or timer changes. A resume keeps the mode its run started in (`STEPS.txt`). Receipts are checked when `SHIP_RECEIPTS` is set and never required. `ship-result.json` says `rehearsed` (or `rehearsed-with-failures`); exit 0 only when every step passed |
| `--no-eyes` | Skips the browser steps (probe-start, probe-check, walks, poster, stall), recording each as `skipped-no-eyes` in `STEPS.txt`; a GPU workstation runs them with [`ship/eyes.mjs`](#the-workstations-eyes). `SHIP_PROBE_CLI` is then not required. `SHIP_PREACTIVATE_CMD`, when set, runs right before the activation (or its `--no-switch` skip) and its failure stops the run with nothing changed. `SHIP_RELEASED_CMD` runs where the probe would be told the release is done; its failure is recorded as `released-hook` and the run goes on. The mode in `STEPS.txt` gains `-no-eyes`, and a resume keeps it |
| `--from <step>` | Resumes at `snapshot`, `stage`, `rehearse`, `backup`, `probe-start`, `healthz`, `walks`, `poster`, `stall` or `cdn-walk`, with the same `--out`. Activation always follows a fresh probe, so resume it `--from probe-start`. The guards run on every resume. |
| `--out <dir>` | Output folder (default `$SHIP_OUT_ROOT/<label>`). A folder that already holds a run is refused without `--from`. |
| `--accept-host-codes <code,...>` | The snapshot normally needs public healthz `hostOk`. With this list it passes while `hostOk` is false only if every `hostCodes` entry is listed, such as `halted` for a release that fixes a halted world. The list is printed and recorded in `snapshot.json` (`acceptedHostCodes`); any other code still refuses, and the drift checks compare `hostCodes` too. |

There is no host option. The host and operator paths come from the environment or the untracked `deploy.env`:

| Variable | Default | Used for |
|---|---|---|
| `SIM_DEPLOY_HOST`, `SIM_DEPLOY_USER` | none / `root` | SSH target of the production host. ship.sh's own lines, the dry-run plan and `ROLLBACK.txt` never name it. Tools tee'd into `ship.log` can (`release.sh` prints its upload target, ssh its errors), so keep `ship.log` private |
| `SHIP_RECEIPTS` | none; required | Folder holding the publishable `release-receipt.json` (`ship-receipt.mjs --public`), or the gate's `receipt.json` and `ship-receipt.json`, for this commit |
| `SHIP_PROBE_CLI` | none; required | God folder of the [release-probe world](#the-release-probe-world) |
| `PLAYWRIGHT_BROWSERS_PATH` | none; required | Browsers folder. Preflight checks that it actually holds a Chromium executable |
| `SHIP_ORIGIN` | `https://soul.game` | Public origin |
| `SHIP_WALK_SLUGS` | `eden mars-college-2026 mars-college-2027` | Worlds for the walks and the cdn-walk |
| `SHIP_PROBE_PAGE`, `SHIP_POSTER_PAGE` | `/w/eden/` | Pages for the probe, and for the poster and stall |
| `SHIP_OUT_ROOT` | `.local/ship` | Parent of the output folder |
| `SHIP_PROBE_READY_S` | `600` | How long to wait for the probe to be ready |
| `SHIP_HOST_MEMINFO` | `/proc/meminfo` | The host's memory figures for the rehearsal's cap (a test seam) |
| `SHIP_HOST_ROOT`, `SHIP_HOST_DATA`, `SHIP_HOST_CONF`, `SHIP_HOST_UNIT`, `SHIP_HOST_TMP` | `/srv/sim-worlds`, `/srv/sim-worlds-data/production`, `/etc/sim-worlds/production.conf`, `sim-worlds@production`, `/tmp` | Paths on the host, passed to its scripts as arguments |
| `SIM_PREBUILT_WEB_ROOT`, `MARS_WEB_SRC` | see [release.sh](#releasesh) | Read by `release.sh` |

| Step | What it does | On failure |
|---|---|---|
| preflight | Local guards: the host is set, the tree is clean, HEAD is `--sha`, the commit is on `origin/main`, the gate and ship receipts are clean for it, the probe folder and Chromium exist, every tool is present | Refused; nothing remote ran |
| snapshot | Public healthz and read-only host metadata: stage link, config hash, registry identity, every database by name (`body-collections.sqlite` too), keeper. Writes `ROLLBACK.txt` | Stops |
| stage | `release.sh production --no-activate` at base `/`; verifies the manifest locally and on the host; compares the host with the snapshot | Stops |
| rehearse | `ship/host-rehearse.sh` on the host: boots a copy of every world's database with the staged tree (`boot-rehearsal.mjs`, 1200 ticks, fake minds, memory-capped scope, read-only on production; no database content leaves the host). The copies live in a `mktemp -d` directory of the run's own under `SHIP_HOST_TMP`, removed with everything in it when the run ends; nothing else is deleted. The scope keeps 3 GB free (the launcher's wake floor is 2.5 GB) and the rehearsal has `oom_score_adj` 1000. Every registered world must pass (an unreadable result is a stop, never a pass); a fork other than Eden's, or an unregistered data directory, is approximate and reported only. A boot over 60 s is flagged slow. Writes `rehearse.json`; the activation requires a passing one for this build | Stops |
| backup | Row-verified compact copy of every database, `quick_check` on each, the same filenames as the snapshot | Stops |
| probe-start | Starts `release-probe.mjs` and waits for `<out>/probe/ready` | Stops |
| activate | Checks that the snapshot and backup are under an hour old and that nothing drifted, then runs `ship/host-activate.sh` on the host: one `activate.sh --reload`, one refresh of host health with the timer's own oneshot (`systemctl start sim-worlds-health@<stage>.service`, so a code recorded before the activation can't fail it), and a health check | Stops and reports the host's exit (below) |
| probe-check | Reads the probe's exit | 3 stops (the release rolled back: a watched page ended on another build). Anything else is recorded and the run continues. A watched page that answered an error when the probe started (a world that is down until this release fixes it) is retried every 5 s and marked when it first loads; one that never loads, or never names a build, is `notLoaded` or `noBuild` in `probe/report.json`: exit 1, never a rollback. A watcher's error pages before it is watched are reported as `errorPagesBeforeReady`, not counted against the release; fresh arrivals always count |
| healthz | Public healthz reports this build, every world and `hostOk` | Stops |
| walks | `ship/walk.mjs` on desktop and phone at dpr 1 and 2, then `checks.mjs walks` | Recorded |
| poster | `ship/poster.mjs` three times, `poster-count.py`, `checks.mjs poster` | Recorded |
| stall | `ship/stall.mjs` four times, `checks.mjs stall` | Recorded |
| cdn-walk | `tools/cdn/cdn-walk.mjs` on the same worlds | Recorded |

The output folder holds `STEPS.txt`, `ship.log`, `POSTLIVE.txt` (each post-live check and its exit), each step's logs and
`ship-result.json`: `live`, `live-with-failures` or `stopped`. The exit is 0 only when every step passed. `ROLLBACK.txt`
has the manual rollback, with the host as `$SIM_DEPLOY_HOST`.

The activation's stop reports what the host's exit says, and `ship-result.json`'s detail names that exit:

| Exit | What happened | What is live |
|---|---|---|
| 80 | A guard on the host refused | The previous build; nothing changed |
| 81 | The activation or its health check failed; the rollback returned success | The previous build; confirm with healthz |
| 82 | The activation failed; the stage link is on the previous build, because `activate.sh` rolled back or never moved it | The previous build by the link; confirm with healthz |
| 90 | The activation failed and the rollback failed | Unknown; act now |
| 91 | The activation failed and the stage link is neither build; no further change | Unknown; read the link and healthz |
| other | ssh dropped or the script died; the host may have rolled back or be rolling back | Unknown; read the link and healthz |

`--from snapshot` keeps the earlier `snapshot.json` beside the new one and refuses once this commit is live, so it can't
name the candidate as the previous build or overwrite `ROLLBACK.txt`. A resume from there takes a fresh backup and probe too.

**A keeper change blocks the next release.** `--reload` keeps the old keeper running, so after a release that changes
`keeper.mjs` the next `ship.sh` refuses (`keeper source differs`, `keeper, source or active build drifted`) until a planned
`--restart`. That is the safe failure. **`SHIP_HOST_DATA` is only partly honoured:** it reaches the snapshot and the activation,
but `compact-backup.sh` has its own hard-coded data path.

Not done here: publishing new CDN assets first, the uncut live clip, the changelog PR, the tag and the GitHub Release.

Tests run the whole command against a fake host, with the remote block under an empty environment:
`node --test tools/world-launcher/ship-root.test.mjs`.

## ship-dual-stage.sh (historical)

The old dual-stage command, kept for the workflow above. Do not run it on the root-only host.

```sh
tools/world-launcher/deploy/ship-dual-stage.sh --label <n> [--dry-run] [--from <step>] [--no-probe] [--exclude-world <slug>] [--out <dir>]
```

| Option | Meaning |
|---|---|
| `--label <n>` | Release label: letters, digits, `-` and `_`. Names the backups (`pre-r<n>-<stage>-<time>`) and the output folder. |
| `--dry-run` | Prints every step with its exact commands. Nothing runs and the host is not contacted. Exits 1 when preflight would stop a real run. |
| `--from <step>` | Resumes at `<step>` after a fix, with the same label and outputs; earlier steps are skipped. |
| `--no-probe` | Skips the three live-probe steps. |
| `--exclude-world <slug>` | Leaves one `/worlds/w/<slug>/` world out of the arrival walks (repeatable). Unknown slugs fail. Backups, probe and activation are unchanged. |
| `--out <dir>` | Output folder (default `$SHIP_OUT_ROOT/<label>`). |

Environment:

| Variable | Default | Used for |
|---|---|---|
| `SIM_DEPLOY_HOST` | none; required | SSH target of the production host (an SSH config alias works); `SIM_DEPLOY_USER` (default `root`) is prepended. Also read by `release.sh` |
| `SHIP_ORIGIN` | `https://sim.eden.art` | Public origin the probe and walks load |
| `SHIP_PROBE_CLI` | `.local/release-probe` | God folder of the release-probe world (below) |
| `SHIP_LEGACY_RELEASE_FILE` | `.local/ship/LEGACY-RELEASE` | File that records the active legacy build after activation |
| `SHIP_OUT_ROOT` | `.local/ship` | Parent of the output folder |
| `SHIP_PROBE_READY_S` | `600` | How long to wait for the probe to be ready |
| `MARS_WEB_SRC` | `.lane/mars-web` | Mars web asset overlay (see `release.sh`) |

Steps, each checked by `ship/checks.mjs`:

| Step | What it does | Pass when |
|---|---|---|
| preflight | Local only: clean tree, `node_modules`, Mars web assets, every ship tool present, the probe god folder, an unused output folder | nothing is missing |
| backup | Copies `ship/compact-backup.sh`, `ship/compact-copy.py` and `ship/quick-check.mjs` to the host; makes a row-verified compact copy of every production and legacy database (`/srv/sim-worlds-data/release-backups/pre-r<n>-<stage>-<time>`); runs `PRAGMA quick_check` on each | every copied row matches its source; every database `ok` |
| legacy-upload | `release.sh legacy`: builds and uploads `we-<sha12>-root` without activating it | exit 0 |
| probe-start | Starts `release-probe.mjs` in the background (desktop and phone pages, god CLI edits in the probe world, `--expect-build we-<sha12>`); waits for `<out>/probe/ready` | ready in time |
| release | `release.sh production --reload` | exit 0 |
| legacy-activate | `sha256sum -c FILES.sha256` in the legacy release, `activate.sh legacy <release> --reload`, then writes the build to `SHIP_LEGACY_RELEASE_FILE` | exit 0 |
| released | Touches `<out>/probe/released`; the probe watches 60 s more | — |
| probe-check | Reads the probe's exit | 0 = pass; 1 = visitor bar missed (the release is live); 3 = the release rolled back |
| walks | `ship/walk.mjs`: a fixed set of worlds on desktop at dpr 1 and 2, a smaller set on a phone | every arrival, 0 errors, 0 resyncs, picks ok |
| poster | `ship/poster.mjs` three times on a phone, then `ship/poster-count.py` | a world frame every run, never blank after it |
| stall | `ship/stall.mjs` four times on a phone | no frame gap over 1 s |
| cdn-walk | `tools/cdn/cdn-walk.mjs` on three live pages, desktop and phone | PASS |

Before the first change on the host, ship-dual-stage.sh reads the current and previous stage links and writes the rollback
commands to `<out>/ROLLBACK.txt`. The output folder also holds `STEPS.txt` (one line per step), `ship.log`, and each
step's logs, JSON and screenshots. Any failure stops the run: it prints what is live at that moment, the
rollback commands and the `--from` that resumes. It never rolls back by itself; `activate.sh` already does that for a
failed handover, and probe exit 3 reports it.

Its tests stub every external command: `node --test tools/world-launcher/ship.test.mjs` (`SHIP_TEST=1` with `SHIP_SSH`,
`SHIP_SCP`, `SHIP_NODE`, `SHIP_PYTHON`, `SHIP_RELEASE_SH` and `SHIP_BUILD`).

## release.sh

```sh
tools/world-launcher/deploy/release.sh [staging|production|legacy] [--no-activate] [--restart|--reload]
tools/world-launcher/deploy/release.sh [staging|production|legacy] --local <absolute dir>   # assemble only
```

It runs from a clean checkout (`git status --porcelain --untracked-files=no` empty) and:

1. **Assembles** `we-<sha12>` (or `we-<sha12>-root` for `legacy`) in `.lane/release/<build>`: `git archive HEAD`
   (committed files only, so no `.env`, data or keys), `BUILD`, and the web app built with `--base /worlds/` (`/` for
   legacy). An earlier local copy is moved aside, never deleted.
2. **Checks the build**: every asset URL is under the base; with the CDN on, the bundle carries the CDN origin and a
   `cdn-manifest-*.json`; the Eden experience pin (`VITE_EDEN_EXPERIENCE_WORLD_IDS`) is compiled in. Hashed assets get
   `.br`/`.gz` siblings (`precompress.mjs`).
3. **Adds the Mars web assets** from `MARS_WEB_SRC` (default `.lane/mars-web`; `tools/playtest/arena/assets-overlay.mjs
   <dir>` builds one from the public site). `/modular` is linked to the commit's own `mars/viewer/public/modular`.
   For `legacy` it writes `FILES.sha256` over every file.
4. **Writes `RELEASE-MANIFEST.json`** (`release-manifest.mjs snapshot`): every file, symlink and mode.
5. **Uploads** to the host with `rsync --link-dest` against the stage's current release. A directory that already
   holds the same build is reused only when its manifest matches and `release-manifest.mjs verify` passes; a partial
   or different upload is refused, never overwritten. Use a new commit instead.
6. **Installs** (`install.sh`, idempotent; not for legacy) and the server's Linux dependencies
   (`pnpm install --frozen-lockfile --filter @souls/server...`) as the `simworlds` user.
7. **Activates** with `activate.sh` unless `--no-activate` (legacy is never activated by release.sh; ship-dual-stage.sh does it).
   Production refuses to activate without `/etc/sim-worlds/production-auth.env` ([auth](operations/auth.md)).

release.sh never prunes local or remote releases. Focused check: `node --test tools/test-harness/release-no-delete.test.mjs`.

| Variable | Default | Effect |
|---|---|---|
| `SIM_DEPLOY_HOST`, `SIM_DEPLOY_USER` | none / `root` | SSH target of the production host |
| `SIM_WORLDS_BASE` | `/worlds` | Production path prefix |
| `SIM_RELEASE_NO_INSTALL` | `0` | `1` stages without `install.sh` (units, timers, `daemon-reload`); dependencies are still installed. `ship.sh --no-switch` sets it |
| `SIM_ASSETS_CDN_ENABLED` | `1` | `0` builds without the asset CDN for one release; other values are refused |
| `SIM_ASSETS_CDN_ORIGIN` | `https://assets.eden.art` | CDN origin compiled into the build |
| `VITE_EDEN_EXPERIENCE_WORLD_IDS` | the qualified Eden world id | Worlds that get the Eden experience; empty disables the check |
| `SIM_GOATCOUNTER` | site default | Visitor counter code or URL; `off` disables ([analytics](operations/analytics.md)) |
| `SIM_GOD_UPLOADS_CDN` | `1` | Route god uploads through the CDN Worker |
| `SIM_PREBUILT_WEB_ROOT` | unset | Use web builds made elsewhere (below) |
| `MARS_WEB_SRC` | `.lane/mars-web` | Mars web asset overlay |

**Prebuilt web.** With `SIM_PREBUILT_WEB_ROOT` set to a directory holding `<build>/dist` and `<build>/WEB-BUILD.json`
for both builds, release.sh installs those instead of running Vite (`prebuilt-web.mjs install`). The receipt must
match the full source SHA, build id, base path, CDN flag and origin and the Eden pin; every artifact hash is checked
before and after copying. `modal-web-build.py` produces such builds on Modal.

## Activation and handover

`activate.sh <stage> <release dir> [--restart|--reload]` runs on the host as root (release.sh calls it over SSH). It
moves the stage link `/srv/sim-worlds/<stage>` to the new release, keeping the old one as `<stage>.previous`, then
either reloads or restarts the unit:

- **Reload** (the running unit is the keeper and the release carries the same `keeper.mjs`, or `--reload`):
  `systemctl reload` sends SIGHUP and the keeper hands the worlds over to the new launcher without closing the port.
- **Restart** (first install, a changed `keeper.mjs` without `--reload`, or `--restart`): every world restarts.

The handover:

1. **prepare**: the running launcher finishes any world creation, holds new boots and registry writes, and lists its
   running worlds.
2. **start**: the new launcher starts and adopts those worlds; it proxies to them and boots nothing yet.
3. **switch**: new connections go to the new launcher. The old one answers what still reaches it with
   `Connection: close`, so each connection ends cleanly after its next response. The launcher keeps idle connections
   130 s, longer than the reverse proxy's idle timeout, so the proxy closes them, never the launcher mid-request.
4. **take over**: one world at a time, the old launcher stops the world (it saves a snapshot and exits), then the new
   launcher boots it on the same data. Requests and viewer sockets for that world wait; they do not fail. A world
   never has two writers.
   - **pre-warm**: before the stop, the new launcher starts the world's next process in standby (`SIM_STANDBY=1`,
     `apps/server/src/standby.ts`): it loads its code and waits for SIGUSR2 without opening its database or port. The
     pause is then the stop plus opening the data. A world is pre-warmed only when the unit's cgroup and the host both
     have room (768 MB by default, `SIM_PREWARM_NEED_MB`); otherwise it boots cold. `SIM_PREWARM=0` turns it off.
   - **canary**: the first world (not an old-world fork) moves first and must answer `/v1/config`. If it cannot,
     nothing else moves: the old launcher serves again, the new one exits and `keeper.json` says `rolled-back`.
     `SIM_HANDOVER_CANARY=0` turns it off.
5. **exit**: the old launcher finishes its last responses and exits.

After the handover activate.sh waits up to 60 s for `http://<loopback>:<port><base>/__sim/healthz` to report the new
build, then requires every world in `<data>/worlds.json` to answer `<base>/w/<slug>/v1/config` within 90 s. On a
canary roll-back it moves the link back and exits 1. On any other failure it moves the link back to
`<stage>.previous` and reloads (or restarts) again, which runs the same handover in reverse; a failed reverse reload
falls back to a restart. The keeper records its pid, sha, the active build and the last handover per world in
`<data>/keeper.json`.

**Reload with a changed keeper.** `--reload` hands over even when the release carries a new `keeper.mjs`: the
running keeper stays and runs the new launcher (no canary until the new keeper is installed). `keeper.json` then
still names the old keeper, so keep passing `--reload` until a planned `--restart` at a quiet time. A change to the
unit file or to `/etc/sim-worlds/<stage>.conf` (port, data, caps) also needs `--restart`.

**Restarts without refused connections.** The optional `deploy/sim-worlds@.socket` lets systemd hold the port, so
during a restart new connections wait in the socket backlog instead of being refused. Its header has the commands to
switch it on (one last restart).

**What a viewer sees.** The page and API never get a refused connection. Each world's viewer socket drops once while
that world moves and reconnects by itself; "Reconnecting…" appears only after 3 s (`apps/web/src/viewer-arrival.ts`).
A page running the previous bundle reloads at once only if the protocol changed; otherwise it swaps bundles after
the tab has been hidden for a minute (`useSouls.ts`).

## Rollback

- **Automatic:** activate.sh puts `<stage>.previous` back on a failed handover, health check or world boot.
- **By hand:** run the command ship.sh wrote to `ROLLBACK.txt`, which is of the form

  ```sh
  ssh "$SIM_DEPLOY_USER@$SIM_DEPLOY_HOST" bash <previous>/tools/world-launcher/deploy/activate.sh production <previous> --reload
  ```

  Do not move the stage link yourself first: activate.sh records `<stage>.previous` only when the link still points
  at the old release.
- Rollback changes code only. World databases keep every accepted event; never restore an older database to make old
  code run. Restoring data is a separate, deliberate operation ([disaster recovery](operations/disaster-recovery.md)).

## The release-probe world

The probe's god CLI edits go to a dedicated world: unlisted, flagged test, owned by an operator account, with no
Soul a person owns. Releases never edit a person's world, and preflight stops when `SHIP_PROBE_CLI` is missing. One-time
setup on the production host (`op.mjs` accepts only direct loopback requests; `<port>` and `<base>` are the
production stage's):

```sh
node tools/world-launcher/op.mjs create-world --port <port> --base /worlds --name "Release probe (scratch)" \
  --template hello-hamlet --owner <account id> --slug release-probe --unlisted
node tools/world-launcher/op.mjs set-test --port <port> --base /worlds --slug release-probe --test true
```

Then, in an empty folder on the machine that will run the release, register and pair a god for it:

```sh
node tools/god-skill/eden-god.mjs register https://sim.eden.art/worlds/w/release-probe/
node tools/god-skill/eden-god.mjs pair          # prints a pairing code and waits
# on the host:
node tools/world-launcher/op.mjs god-pending --port <port> --base /worlds --slug release-probe
node tools/world-launcher/op.mjs god-approve --port <port> --base /worlds --slug release-probe --code <code>
```

Keep that folder as a secret of the release environment and point `SHIP_PROBE_CLI` at it; never print its session
file. Operator Soul and god commands work only on loopback and on worlds flagged test (`apps/server/src/op-souls.ts`,
`tools/world-launcher/op-souls.mjs`); they approve only TEST names for a synthetic operator account, and `god-approve`
is refused while any live Soul in the world belongs to anyone else.

## Retention

Nothing is pruned automatically. `tools/world-launcher/deploy/retention.sh --host "$SIM_DEPLOY_USER@$SIM_DEPLOY_HOST"` lists what
keep-N would delete on the host: routine compact backups beyond the newest 10 per stage (other backup names are never
touched) and legacy releases beyond the newest 5, always keeping every release a link points at or a process uses.
Dry run is the default; `--apply` deletes and should be run only after reading the dry-run list. `--keep-backups` and
`--keep-releases` change the numbers (at least 3 and 2). Test: `tools/world-launcher/deploy/retention.test.sh`.

## Measuring a handover

`deploy/swap-probe.mjs --origin http://<loopback>:<port> --base /worlds --slugs a,b --out probe.json [--posts]` GETs the
homepage and each world every 100 ms, holds one viewer socket per world, and reports refused connections, 5xx, the
longest error run, the slowest request and each socket's downtime. `--posts` adds a POST per world, which catches a
connection closed under a request. Run it through a reverse proxy with production-like transport settings to see
what a visitor would.

## Root-only world deployments

[`ship.sh`](#shipsh) sets `SIM_WORLDS_BASE=/` for a root web build; run the launcher with `--base /`. Existing `/worlds`
releases remain supported. Follow [world URL migration](operations/world-urls.md) to preserve world identities and paired
agents when changing public slugs.

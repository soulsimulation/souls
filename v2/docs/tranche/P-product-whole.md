# The product whole: the eighteen tasks from the inheritance audit

Draft, local only, 17 Nov 2026. Written to `FORMAT.md`, with its "Rules added at the final audit". The tasks keep
their lanes' letters (K, O, R, W, B, G, V, X); this file only groups them. The trunk is `TRUNK.md`; the rulings
are `FINAL-AUDIT.md`; the source is section 3 of `AUDIT-inheritance.md`.

## Why these tasks exist

The first design put the new core inside today's server, so sign-in, the pages, releases, the client's delivery
and the docs all stayed as they were. Revision 2 replaced the whole server and web app, and the tasks that
carried those things went with the lane that was cut. The inheritance audit counted 123 things people or
operations rely on today and found 47 with no home, 14 of which stop the cut-over itself: nothing installed the
new programs on the production machine, routed the public name, released the code, packaged the client or
moved accounts. These eighteen tasks carry those rows, and X12 is the gate that shows the product whole before
the switch (X7).

## Changes from the audit's table

| Task | Change | Reason |
|---|---|---|
| K15 | New title; first task of the tranche; depends on nothing (was K1), and K1 depends on it; ceiling 2 → 3 h. `v2/` is T1 until the cut-over; the strict tiers are written down and switched on by X8 (the audit switched them on at once). It also adds the CI scope, a `v2` job proved on a seed crate, and the committed trunk, rules, lane files and inventory | The planner's ruling. A `v2/`-only change selects every job today, and no later task can cite a file that is not in the repository |
| O17 | Depends on: + R3, V5, W2. "Gene's yes" leaves the header for the owner's checklist. The preview is a path on the public name | The outcome plays the page and pairs an agent; the view tier is one of the programs. Only the configured origin mounts sign-in (`docs/operations/auth.md`), so a preview on another name cannot sign in without the owner |
| O18 | Depends on K15 in place of K1. The list of checks lives in `v2/docs/release.md` with one pointer from `docs/release.md`, not in `docs/testing.md` | `docs/testing.md` describes today's gates, which stay true until X8 and X14 |
| O19 | Depends on: + W8. Old API paths are not redirected | The route for a slug comes from the directory. A redirect drops a token; old clients get R18's frozen answers |
| O20 | Ceiling 2 → 3 h. Depends on: + O12. Adds the text store and the owner's mailbox. Backs up by a checked-in list of stores, with a loss bar of five minutes | T8 keeps all free text out of the log, so O12 would restore a world with no words; the audit's row missed it. Bookmarks (W6) and the removal list (W7) are built at stage 3 and cannot be dependencies of a stage 2 task |
| R17 | Depends on: K1 dropped, + R7, O18. Serves under today's frozen names | The bundle is a release artifact named by hash. R18 then renames nothing |
| R18 | The compatibility test and a pinned copy of the released client move into `v2/` | X8 deletes the folder that holds them, and the frozen answers must outlive it |
| W10 | Header unchanged. R13 owns the mailbox and delivery; this task owns what the person sees | R13's outcome already types a message on the page |
| W11 | Title and outcome lose "disconnect its agent". Depends on: + G6, K10, R12 | Disconnecting is W9's revoke: one call, not two. The picture passes G6's gate, a retire is K10's, and the one line needs R12's skill |
| B15 | Ceiling 2 → 3 h. Depends on: + W11, V13 | Two ways in (the page, the agent) at creation and later. The page needs the owner's short token and a place to sit |
| G10 | Depends on: W9 dropped, + G6, W3 | W9 is stage 3. The list picture is one field of the directory record, set from the creator's client |
| V19 | Depends on: + V6, V9 | The outcome measures V6's bars and a replayed moment |
| V20 | A build order and a hand-back point for the broadcast camera | Four things in four hours; the owner may yet choose a free camera |
| V21 | "Soul Actions D7" leaves the header for Step 0. Depends on: + V8, V9. The radio is another path | Not a task in this tranche. Things' sounds come from their kinds, and replay is in the outcome |
| X11 | Depends on: + X6, K10. It leaves a private table of old to new Soul ids | A Soul is born into a world that must exist. R14 and R18 need the table |
| X12 | Kind `gate`. Depends on: + B15, G10, V19 to V21, O18, X13; the Soul Actions lines move to Step 0. The bar is the list of rows, fixed before the walk | The planner's ruling. A row with no task behind it cannot be walked |
| X13 | Depends on: + R17. New pages live in `v2/docs/site/` | "For agents" needs a served client. Today's pages must stay true until the switch |
| X14 | Depends on X7, not X8. Workflows are left to X8 | The audit made X8 depend on X14 and X14 on X8. Workflows still run today's system until it is deleted |

In every task, a step only the owner can take is a "Waits for the owner's checklist" line and not an
acceptance box, so that the acceptance holds only what a lane can prove. Ceilings: 62 h in all (the audit
had 59).

## What these tasks need from tasks in other files

Not edited here; for the planner.

- **K1** depends on K15, and fills the `v2` job K15 adds in place of adding one.
- **X5** depends on O17: its fork of Eden runs on programs O17 installs.
- **X7** depends on X12, O19, R18 and E17 (`FINAL-AUDIT.md`). **X8** depends on X14 and O18, and switches on the
  strict tiers K15 wrote down.
- **X6** keeps rooms, things and uploads; accounts and Souls are X11's.
- **R14**'s Step 0 reads X11's table. **W9**'s revoke is what W11's list links to. **V15** reuses G10's capture.
- **W6**, **W7** and **R13** each add their store to O20's list. **O13** indexes the runbook pages O17, O18 and O20 add.

## What every task in this file keeps

- **Words.** The **preview** is the new system on the production machine, reached through the real proxy at an
  address nobody is sent to. The **front door** is that proxy and its routes. The **owner** is Gene. A **home**
  is the `.souls` folder on a Soul owner's machine. The **frozen answers** are the few addresses and replies
  every installed client upgrades through (`docs/architecture/api.md`, "Soul client upgrade (frozen)").
- **What only the owner can do is not the lane's work.** A yes, a purchase, a person named, anything on the
  production machine, its proxy, its backups or its DNS: the task says "Waits for the owner's checklist: ...".
  The release owner carries such a step out from a workflow once the owner has said yes, and posts the result
  on the task. The acceptance holds only what a lane can do and prove, on a scratch Linux machine or a local
  world under `.local/`. (X12 is the exception: it is the walk itself.)
- **A task that adds an operator command** writes its own page, `v2/docs/runbook/<situation>.md`, as lane O's
  tasks do.
- **A measured or watched outcome** is declared in a comment on the task before the run, with two repeats. A
  watched outcome is one uncut, real-speed clip.
- **Nothing private in public.** No message, account id, token or device detail reaches a log, a public view,
  a pull request or a clip. `node tools/proof/publication.mjs` runs on all outgoing text; clips are checked by eye.
- **Fixed decisions.** Minds stay outside the engine. The engine holds no order that waits for a time or a
  condition. Old worlds' history is expendable and there is one clean start. Places and things carry facts,
  never labels of character.
- **Carried by copying.** "Carried over" means the file is copied into `v2/` with its tests. Nothing in `v2/`
  imports from today's tree.
- **A new workflow file** is on a strict path that no scope rule names: its pull request runs every CI job
  and lands rebased.
- **Counting.** Each task body is 220 to 340 words, not counting its heading, its header table and list marks.

## Today's system, read on `origin/main` at `ee208bfdb`

| Area | What is there today | Where |
|---|---|---|
| Proof tiers | First match per path; `v2/` has no rule, so it is T1 by `default_tier`; the policy file itself is T3 and waits for the maintainer | `docs/process/PROOF-POLICY.yml`, `tools/proof/tier.mjs` |
| CI scope | A path no rule names runs every job; docs and tools run none; a job with `steps: []` is picked by its own `paths`; a push to `main` runs everything | `.github/scripts/ci-scope.mjs`, `SCOPE_RULES` in `tools/test-harness/release-gate.mjs` |
| Strict paths | Engine packages, the lockfile, baselines and `.github/workflows/` land rebased and re-tested | `STRICT_PATHS` in `.github/scripts/merge-train.mjs` |
| Install | One idempotent script: an unprivileged user, folders, one unit, settings. It starts nothing and never touches the proxy, DNS or firewall. Worlds may use 24 of the machine's 31 GB | `tools/world-launcher/deploy/install.sh`, `docs/operations.md` |
| Release | One commit of a clean tree; assets to the CDN first; staged, rehearsed on copies, backed up, then one guarded reload; health, walks, a feed item; dry run by default; a freeze between pin and ship | `docs/release.md`, `.github/workflows/release.yml` |
| Rollback, changelog | A workflow that refuses unless the live and previous builds are the ones named; the changelog, tag and release written by a second workflow through a pull request | `.github/workflows/rollback.yml`, `publish.yml` |
| Front door | The proxy ends TLS; its site files are placed once by hand and a release never writes them. Two older domains redirect, keeping path and query; `/sign-in` on the older one is the sign-in bridge. Old world addresses answer a same-origin 308; old API paths are routed, not redirected | `docs/operations.md`, `docs/operations/world-urls.md`, `docs/operations/clerk-satellite.md`, `tools/world-launcher/deploy/caddy/` |
| Behind the CDN | The visitor's address is trusted only from the CDN's ranges; unsigned answers are kept 5 s and served stale 30 s; a "back in a moment" page when the origin is down | `docs/operations/cdn.md` |
| Crawlers, framing | Robots and sitemap from the registry, waking no world; pages refuse framing | `tools/world-launcher/crawl.mjs`, `docs/operations/analytics.md` |
| Visitor counts | Cookieless; never a query, hash, Soul id or token; automation left out | `apps/web/src/visitor-counts.ts`, `docs/operations/analytics.md` |
| Backups | Nightly: every SQLite file by the online backup call, checked, then an off-site copy and a restore drill; the recovery key is kept off the machine | `docs/operations.md` ("Backups"), `.github/workflows/offsite-backup.yml` |
| Accounts | (issuer, subject) maps to a random account id in one registry; the original worlds are forks with their own; memberships and ownership stay in each world's database | `docs/operations/auth.md`, `docs/architecture/worlds.md` |
| The client | One file and one skill served at the world's address; `soulClient` in `/v1/config` gives version, length and hash; `upgrade` checks all three, keeps one version back, follows no redirect and trusts only the home's first site | `docs/architecture/souls.md` ("The Souls home"), `tools/world-launcher/soul/` |
| Old to new client | Refused while another world in the home speaks another contract; a compatibility test upgrades a pinned released client through the frozen answers | `tools/world-launcher/soul-upgrade-compat.test.mjs`, `tools/world-launcher/soul/released/` |
| Owner messages | An inbox per Soul; the owner sees `thinking`, then the newest act with its receipt phase, read only from world records; the page asks every 2 s | `apps/server/src/edge/owner-doing.ts`, `apps/web/src/inbox-poll.ts` |
| My Souls | The "New Soul" card with the one line; a list with connection chips; retire asks and the person clicks | `apps/web/src/BringAgent.tsx`, `MySouls.tsx`, `docs/architecture/souls.md` |
| Bodies | Presets pinned by content hash; a world stores the hash, never the preset's name; a look picker in the page | `docs/design/custom-bodies.md`, `apps/web/src/humanoid/LookPicker.tsx` |
| Pictures | `shoot` draws the public page in a headless browser on the agent's machine, anonymous; `view` is drawn by a browser per world on the server, within budgets | `docs/architecture/souls.md` ("Eyes") |
| Sky and weather | Sun and sky from the world clock; weather chosen by the page per slot and eased over viewing time | `apps/web/src/daylight.ts`, `apps/web/src/atmosphere/` |
| Cameras | Follow, a flight to a Soul, a broadcast director | `apps/web/src/WorldFollow.ts`, `WorldSoulFlight.ts`, `WorldBroadcast.ts`, `WorldDirector.ts` |
| Sound | All synthesised, planned by a pure module; one tab sounds at a time | `apps/web/src/gen-mesh/sound-plan.ts`, `apps/web/src/audio-focus.ts` |
| Public docs | Pages in `docs/site/`; three reference pages generated from the server's modules; linted; built into the web app and served at `/docs` with `/llms.txt` | `docs/site/WRITING.md`, `tools/docs/`, `apps/web/src/docs-site.ts` |
| Files naming today's tree | 85 under `docs/` and `.claude/`, 20 under `.github/` (one search for `apps/server`, `apps/web`, `mars/`, `packages/engine`, `tools/world-launcher`, `tools/god-skill`, `tools/edge-skill`) | counted |

## Facts I could not verify

- **Nothing was run.** Today's behaviour is taken from documents, file lists and header comments on
  `origin/main`, not from running code. The tier and scope results in K15 are the process audit's; I read
  the code that gives them and did not run the tools.
- Whether one job of `ci.yml`'s matrix can skip the dependency install without changing what the release gate
  reuses from CI.
- The production machine's system release, and whether both systems fit in its memory (O14 answers).
- Whether today's released client accepts the new one as an upgrade. Its contract rule suggests a home with
  Souls in an old and a new world is refused.
- Where T8's text store and removal list live, and which program owns them. No task names either.
- Whether V6 draws a look per instance, and whether V5's page draws in a headless browser with no GPU.
- Whether Eden's imported kinds carry sound. I did not read Soul Actions' task bodies.
- The sign-in provider's and the CDN's dashboard settings. No issue or pull request was opened.
- R12's stage: `FINAL-AUDIT.md` rules win 3, and `INDEX.md` still says stage 2. Either satisfies these tasks.
- No web source was fetched for this file; it cites repository paths only.

---

# Releasing Engine v2

Engine v2 O18 (#2811). A release of the new system is one commit: built once on a GitHub runner, staged on the machine
by hash, moved world by world behind a canary, and rolled back by a workflow. No step needs a shell on the machine.
Today's system still ships by [docs/release.md](../../docs/release.md); what carries over from it: HEAD of a clean
tree, a dry run by default, the freeze, a rollback that refuses unless the live build is the one named, data never
rolled back, and the changelog, tag and one news item written once.

The code is [`v2/tools/ops/release/release.sh`](../tools/ops/release/release.sh); the workflows are
[`release-v2.yml`](../../.github/workflows/release-v2.yml) and [`rollback-v2.yml`](../../.github/workflows/rollback-v2.yml).
How a world's pin moves and comes back: [deploy-and-roll-back.md](runbook/deploy-and-roll-back.md) (O7); the
gateway: [gateway-upgrade.md](runbook/gateway-upgrade.md) (O16); the machine's layout: [install.md](runbook/install.md)
(O17).

## The checks a release head must pass

`release-v2.yml` refuses a head where any of these has no successful run, one line per check by name
(`refused: release.missing-check: <name> has not passed at <sha>`). The list is read from between the markers below;
change it here. The merge queue's green `ci` run at the head counts for `ci-ok` and the five v2 legs (0.133 R13): a
pull request enters the queue only with `ci-ok` green at its own head, which needs every v2 leg its paths select, the
queue's run checks that the combined code compiles, and the queued commit lands on main as itself. Main's own push run
is often cancelled by the next merge and runs no leg its paths do not select, so a merged fix needs no re-run. Plainly:
the v2 legs' tests ran on each pull request's own head, not on the tree that ships; the merge queue only compiled
that tree (`cargo check`).
`scrub-guard` and `gitleaks` must still pass at the head (the queue runs them).

<!-- release-checks -->
- `v2-rust`: one of the five CI legs that together run `v2/tools/ci.sh` (`.github/scripts/ci-scope.mjs` `V2_LEGS`)
- `v2-sim`: another of those legs
- `v2-worldd`: another of those legs
- `v2-wasm`: another of those legs
- `v2-client`: another of those legs
- `ci-ok`: the light set of every change (build and types, bundle, smoke, affected tests)
- `scrub-guard`: no device details, secrets or personal data in the tree
- `gitleaks`: no secrets
<!-- /release-checks -->

## A release

```sh
gh workflow run release-v2.yml --ref main -f version=<v> -f sha=<full sha>                 # the dry run (default)
gh workflow run release-v2.yml --ref main -f version=<v> -f sha=<full sha> -f dry_run=false
```

1. **Preflight.** `sha` (default: main's HEAD, under `RELEASE_FREEZE` as today's release) is a full sha on main; the
   checks above passed at it.
2. **Build once.** At that commit: the world process (`worldd`), the gateway (`gatewayd`), the page (`v2/web`'s
   build, as `page.tar`) and the served client (`v2/client/served/build.mjs`, stamped with the version: `eden.mjs`,
   `skill.md`, `instructions.md`, the daemon's library and `soul-client.json`, as `client.tar`), the directory
   (`directoryd`), the viewers' origin (its files as the install places them, `install.sh origin`, as `origin.tar`) and
   their two unit files (`souls-directory.service`, `souls-origin.service`, as `units.tar`), with the tools that move
   them (`deploy`, `gateway-upgrade`), `publish-template` and the placement scripts (`ops/`, New world below).
   `manifest.json` names each artifact by its hash: the SHA-256 multihash (`1220` and 64 hex), as O1 names a build,
   and each served file by name, version, hash and length (`served`). The bundle is the run's artifact.
3. **Stage.** The bundle goes to the machine over ssh; each artifact lands at `$WORLDS_ROOT/builds/<hash>/<name>`
   (`/var/lib/souls/worlds`) only if its bytes hash to the manifest's, and `worldd schemas` must run there first (a
   binary built against a newer system library than the machine's does not start: `release.will-not-start`). The
   release's record (manifest, tools, `release.sh`) is `/var/lib/souls/releases/<sha>/`, with `world-aside` among its
   tools and, under `reseed/`, Eden's reseed, its undo, the kinds at the commit and Eden's stock with its libraries
   (`reseed/stock`: `stock.json`, `library/`; the reseed seeds with them, #4837). It prints the staged files'
   hashes against the manifest's. A dry run stops here: builds by hash are inert until a pin names one.
   - **Reseed (input `reseed`).** When this build cannot read Eden's store (`header-mismatch`), `reseed=fresh` starts
     Eden fresh on it before the move ([cutover.md](cutover.md#a-fresh-eden-on-a-new-build-0132)): `release.sh reseed
     <sha> check`, then `run`; a dry run runs only the check. A label resumes a reseed that stopped; `fresh` refuses,
     naming the label to resume, when Eden is already pinned to this build or a reseed to it is not undone. Eden is
     the canary of the move that follows. The label and the undo line reach the summary even when it stops. Its undo
     is `rollback-v2.yml -f reseed=<label>`, which takes a turn in the `release` group. Store calls retry a dropped
     connection, a stall or a 5xx with back-off (world-aside's `tried`).
4. **Move.** The canary world (input `canary`, default the first by name) by `deploy`: rehearsal, pin, restart, the
   canary watch, a rollback by itself on a fault. Then every other world, one at a time; then the gateway by
   `gateway-upgrade` (never in the same step as a world's deploy: the step lock), after `mailbox apply` gave the
   owner's messages their settings where missing (the mailbox key, made once; `--mailbox-key` in `directory.args`;
   `--mailbox <directory> --mailbox-key` in each `gateway-<world>.env`; a rerun restarts a gateway or the directory
   that had already moved when its file changed); then the page (`/usr/local/lib/souls/web`);
   then the served client (`/usr/local/lib/souls/client`, which a world's address answers from, `v2/client/served/serve.mjs`);
   last the directory (`souls-directory`), then the viewers' origin (`souls-origin`). For each, the release's program
   (`/usr/local/lib/souls/directoryd`, the folder `/usr/local/lib/souls/origin`) and unit file go in beside the old ones
   and are renamed over them (`systemctl daemon-reload` when the unit file changed), the unit is restarted once (a
   blip of a second or two; the page tries again), and it must answer as healthy within 30 s: the directory `401` to
   `POST /v1/account/session` without a token, the origin `200` for the first world's stream pointer
   (`/w/<world>/<views/world.json stream>pointer`, or `/v1/feed` when no world has a stream). When it does not, its
   previous program and unit go back, it is restarted on them, and the release stops with
   `release.directory-unhealthy` or `release.origin-unhealthy`, saying what the previous one answers.
   Then `mailbox check`: one owner's message, for a grant no Soul holds (nothing reads it; it expires unread), sent
   through each world's gateway with a view token minted from the install's view key, must be accepted; any refusal
   (`no-mailbox`, `not-taken`, unreachable) stops the release with `release.mailbox-unreachable`.
   A failed deploy stops the release: worlds before it keep the new build, worlds after it the old. Each world's probe
   enters and retires its own unpaired operator body through K10/C3 and requires an ordinary committed action,
   so a release never drives a user's Soul
   ([deploy-and-roll-back.md](runbook/deploy-and-roll-back.md#what-a-deploy-does)). Each step is done
   once per release (`releases/<sha>/moved/`), so a second dispatch of the same commit moves nothing again.
   **The body catalogue** (`release.sh bodies`): before the deploys, each world's folder gets the page's `bodies.json`
   (the body files the bundle built, `assets/bodies/`) when it has none, or when the release's admits every body its
   own does; its deploy's restart reads it (worldd reads `bodies.json` only at start), so `wear` admits the presets.
   A fork keeps its own (its boot pins it), and so does a world whose catalogue has a body the release's lacks (a Soul
   wearing it could not start). After the page moves, each world of the launcher's cutover binding that names no
   catalogue gets `bodiesDir` `/usr/local/lib/souls/web/assets/bodies`, served at `/w/<slug>/v2/bodies/` and named in
   its page's `v2Bodies` ([cutover.md](cutover.md)); the launcher reads the binding again within a second.
   **The library entries** (`release.sh entries`, `worldd entries`): a world's kinds come from its own folder
   (`<world>/entries/`, one `<kind>.json` each), which its seed wrote once and every start reads, so before this step
   a content fix reached only a world that was reseeded. Before the move, `entries plan` lists for each world which
   entries this release's `content/kinds` (staged as `reseed/kinds`) changes, and which change is refused and why; it
   changes nothing and its output is in the summary, dry run or not. In the move, just before each world's deploy,
   `entries stage` writes that world's whole entries with the changes (each repaired against its facts as a seed
   repairs them) as `<world>/entries.next`, never touching `entries/`. The deploy rehearses the new build on a copy of
   the folder with them and swaps them in between the pin and the restart (the world's own kept as
   `entries.before`), so only the new build ever reads them, and its one restart takes them under the world's own
   header (a changed entry's new revision is paired with the one the header pins). A deploy that fails before the pin
   leaves the world's own; one rolled back by its canary puts the world's own back only when the new build wrote
   nothing under the release's (data never rolls back), and the move removes what it staged. A change the world's
   state may no longer fit is refused by name and nothing of that world is staged: a state field gone or retyped, an
   enum value gone, an int's range narrowed, a slot gone, renumbered or admitting less, a role gone, another owner, a
   world that would not build or would leave a pinned revision with no definition (`entries.<name>`). A fork keeps its
   entries (its boot pins them), so a world made from a template gets no new Soul Action yet; an entry only the world
   has is kept. An entry only the release has is added to every other world (#4954), so a new Soul Action reaches it
   with the release, no reseed: `entries plan` lists each as `add <kind>`, and the world's next start defines its
   kinds in the world's history at its first tick (`kinds defined: ...`, each a `souls:kind` node naming the pin; the
   entry stays in the world's entries), as a creator's kinds are, since the header a world's log names never changes;
   its log before them replays unchanged. A kind the header pins by another revision is not one of these: it is paired
   as before or stays unmade. The library's names are every world's: a world's own entry of the same name in its own
   namespace overrides one, which is then not added. A later `rollback-v2.yml` moves code only: the release's
   entries stay, the world's earlier ones are in `entries.before` for a hand put-back while the world is stopped.
   **New world** (`release.sh placement`, #5047, #5051): the placement initializer forks a template of the catalogue
   (`/usr/local/lib/souls/templates`) with the library's `worldd`, which must hash to `/etc/souls/placement.json`'s
   `build`, and `worldd` forks only a template published on its own build. So after the move, each template there (a
   folder with a `template` file: `eden-2026`, `mars-camp`) is seeded again from what it carries (facts, entries,
   moves, entry point, body catalogue) by the release's `worldd`, published by its `publish-template` and dry-run
   forked by its `worldd`, all in `.templates.next` beside the catalogue, never in it (the directory lists every folder
   in it holding a `template` file). A dry run stops there and changes nothing. A real release then renames into place,
   back to back: the release's `worldd` and `ops/` in the library (the previous kept as `.worldd.prev`, `.ops.prev`),
   the pin (`.placement.json.prev`) and each template (the previous under `templates/.aside/<name>`). The directory
   reads the catalogue (each template's name, lineage and zone) only at its start, and a republished template has a
   fresh lineage, so it is restarted when that changed and must answer `401` as above; if it does not, every rename
   goes back and it is restarted on the previous catalogue (`release.placement-directory-unhealthy`). Any failure
   before the renames (`release.template-seed`, `-publish`, `-fork`) fails the job and leaves the previous templates,
   `worldd` and pin. Done once per release (`moved/placement`).
5. **Publish.** Only when every world runs the release: one news entry in `/var/lib/souls/news.jsonl`, keyed by its
   link (`<origin>/changelog#v<version>`); the tag `v<version>` at the sha and its GitHub Release; the changelog's
   section through a pull request (`release/changelog-<version>`), as `publish.yml`. Each is skipped when already
   there, so a second dispatch adds no section, tag or entry; a tag at another commit is refused
   (`release.tag-elsewhere`). Today's `release.yml` tags the same `v<version>` line, so the preflight refuses a
   version already tagged at another commit before anything is staged: whichever workflow ships a version first owns
   its tag (0.131 is `release.yml`'s, which carries the cut-over fence; the first v2 release is 0.132 or later).
   The viewers' origin serves the entry in the feed (`/v1/feed`, today's shape) on its next read, and the page the
   release moved carries the changelog with this release's section compiled in (`/changelog`, `/changelog.md`), both
   from `v2/tools/origin/site.mjs` (O23).

## Called by release.yml

`release.yml` calls this workflow twice (`v2=true` by default) so one dispatch takes a sha through both releases
([docs/release.md](../../docs/release.md#a-patch-release-in-one-run)): `part=stage` (its **v2** job) builds and stages
beside today's ship, under ship's own conditions, and `part=move` (**v2-move**) runs only after ship's verdict: the
reseed when asked, then the move and the news entry. `release.yml`'s preflight runs the checks above first, so a
refusal stops both releases before anything moves. Called, it runs in `release.yml`'s turn on the machine (a
concurrency group of its own), always against `production`; its own tag, Release and changelog steps are skipped,
and `release.yml`'s publish makes them once, after both releases passed and Eden's page answers.

## A rollback

```sh
gh workflow run rollback-v2.yml --ref main -f to=<good build> -f from=<live build> -f worlds="<world> ..."
```

Each world goes back by `deploy rollback`: its pin must be `from` (`rollback.wrong-from` otherwise, changing nothing),
the old build must read every schema the new one writes (`rollback.schema-unread`), then the pin goes back, the world
restarts and the probe must be answered. `from` must be a build some staged release brought
(`rollback.from-unknown`), and `to` must be on the machine. Code rolls back; data never does. The gateway goes back by
running `gateway-upgrade` with its old build ([gateway-upgrade.md](runbook/gateway-upgrade.md)).

## Configuration

The workflows run in a GitHub environment chosen by the input `target`: `scratch` (a throwaway machine) or
`production`. Each environment holds `DEPLOY_SSH_KEY` and `SIM_DEPLOY_KNOWN_HOSTS` (secrets) and `SIM_DEPLOY_HOST`
and `SIM_DEPLOY_USER` (variables or secrets), as `install-v2.yml`; the machine is one O17's install made.

## Proving it without a machine

[`scratch.sh`](../tools/ops/release/scratch.sh) makes a throwaway machine in one folder (two Eden worlds seeded by
`worldd seed`, placed as `place-world.sh` places them and served by `worldd serve` from their pins, their gateways,
and a `systemctl` that plays systemd's part), and is release.sh's transport for it:

```sh
cd v2 && cargo build --release -p worldd -p gatewayd -p supervisor -p directoryd
cargo build --release -p ops --bin deploy --bin gateway-upgrade
bash tools/ops/install.sh bundle <install> target/release <page folder>  # the body files: tools/ops/release/bodies.ts
bash tools/ops/release/scratch.sh up <dir> <install> <eden facts.json> ../content/kinds
export RELEASE_SSH="bash tools/ops/release/scratch.sh ssh" RELEASE_TARGET=<dir>
bash tools/ops/release/release.sh bundle <out> <sha> <version> <bins> <page folder> client
bash tools/ops/release/release.sh remote stage <out>
bash tools/ops/release/release.sh remote move <sha>
bash tools/ops/release/scratch.sh down <dir>
```

The facts file is N1's export (`v2/tools/import-eden`). `<bins>` holds `worldd`, `gatewayd`, `directoryd`,
`deploy` and `gateway-upgrade`; `scratch.sh build <dir> <label> [plant|mute]` makes a `worldd` that runs the machine's, or one that
dies when served (`plant`), or one that never serves (`mute`).

## Known limits

- The workflows have not been dispatched: a new workflow runs only once it is on main, and the `scratch` and
  `production` environments wait for the owner's checklist. Every step they run was run on a scratch machine.
- `install.sh apply` with an older bundle writes its own page, directoryd, origin and their units over released ones.
- The scratch machine runs no directory and no origin (`scratch.sh` sets `RELEASE_SERVICES` empty), so its move skips
  them; `release.test.mjs` proves that step with stand-ins for `systemctl` and `curl`.

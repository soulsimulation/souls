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
is often cancelled by the next merge and runs no leg its paths do not select, so a merged fix needs no re-run.
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
   `skill.md`, `instructions.md`, the daemon's library and `soul-client.json`, as `client.tar`), with the tools that
   move them (`deploy`, `gateway-upgrade`). `manifest.json` names each artifact by its hash: the SHA-256 multihash
   (`1220` and 64 hex), as O1 names a build, and each served file by name, version, hash and length (`served`). The
   bundle is the run's artifact.
3. **Stage.** The bundle goes to the machine over ssh; each artifact lands at `$WORLDS_ROOT/builds/<hash>/<name>`
   (`/var/lib/souls/worlds`) only if its bytes hash to the manifest's, and `worldd schemas` must run there first (a
   binary built against a newer system library than the machine's does not start: `release.will-not-start`). The
   release's record (manifest, tools, `release.sh`) is `/var/lib/souls/releases/<sha>/`, with `world-aside` among its
   tools and, under `reseed/`, Eden's reseed, its undo and the kinds at the commit. It prints the staged files'
   hashes against the manifest's. A dry run stops here: builds by hash are inert until a pin names one.
   - **Reseed (input `reseed`).** When this build cannot read Eden's store (`header-mismatch`), `reseed=fresh` starts
     Eden fresh on it before the move ([cutover.md](cutover.md#a-fresh-eden-on-a-new-build-0132)): `release.sh reseed
     <sha> check`, then `run`; a dry run runs only the check. A label resumes a reseed that stopped. Its undo is
     `rollback-v2.yml -f reseed=<label>`. Store calls retry a dropped connection or a 5xx with back-off.
4. **Move.** The canary world (input `canary`, default the first by name) by `deploy`: rehearsal, pin, restart, the
   canary watch, a rollback by itself on a fault. Then every other world, one at a time; then the gateway by
   `gateway-upgrade` (never in the same step as a world's deploy: the step lock); then the page (`/usr/local/lib/souls/web`);
   then the served client (`/usr/local/lib/souls/client`, which a world's address answers from, `v2/client/served/serve.mjs`).
   A failed deploy stops the release: worlds before it keep the new build, worlds after it the old. Each world's probe
   enters and retires its own unpaired operator body through K10/C3 and requires an ordinary committed action,
   so a release never drives a user's Soul
   ([deploy-and-roll-back.md](runbook/deploy-and-roll-back.md#what-a-deploy-does)). Each step is done
   once per release (`releases/<sha>/moved/`), so a second dispatch of the same commit moves nothing again.
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

`release.yml` calls this workflow (its **v2** job, `v2=true` by default) so one dispatch takes a sha through both
releases ([docs/release.md](../../docs/release.md#a-patch-release-in-one-run)). Called, it runs in `release.yml`'s turn
on the machine (a concurrency group of its own), always against `production`, beside today's ship; its own tag,
Release and changelog steps are skipped, and `release.yml`'s publish makes them once, after both releases passed.

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
bash tools/ops/install.sh bundle <install> target/release <page dist>
bash tools/ops/release/scratch.sh up <dir> <install> <eden facts.json> ../content/kinds
export RELEASE_SSH="bash tools/ops/release/scratch.sh ssh" RELEASE_TARGET=<dir>
bash tools/ops/release/release.sh bundle <out> <sha> <version> <bins> <page dist> client
bash tools/ops/release/release.sh remote stage <out>
bash tools/ops/release/release.sh remote move <sha>
bash tools/ops/release/scratch.sh down <dir>
```

The facts file is N1's export (`v2/tools/import-eden`). `<bins>` holds `worldd`, `gatewayd`, `deploy` and
`gateway-upgrade`; `scratch.sh build <dir> <label> [plant|mute]` makes a `worldd` that runs the machine's, or one that
dies when served (`plant`), or one that never serves (`mute`).

## Known limits

- The workflows have not been dispatched: a new workflow runs only once it is on main, and the `scratch` and
  `production` environments wait for the owner's checklist. Every step they run was run on a scratch machine.
- `install.sh apply` with an older bundle writes its own page over a released one.

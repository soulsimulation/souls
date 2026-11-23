# The cut-over: Eden serves from the new engine

Engine v2 X7 (#2836). Eden moves to the new engine in one planned step behind the same public name, with a tested
way back. The commands are [`v2/tools/ops/cutover/`](../tools/ops/cutover/); the front door they move is O19's
([`proxy/README.md`](../tools/ops/proxy/README.md)). The release owner runs them, with Gene's yes.

**Gene's decisions (19 Nov, recorded on #2836):** the new system is installed beside today's on the production
machine for the rollback window; Eden switches behind the same front door, with no DNS change, after a preview of
about 2 hours; old Eden stops taking acts and is kept untouched; the rollback window is 24 hours; accounts and Souls
made after the switch are kept untouched in the new system on a rollback and return at the next switch, and nothing
is copied back. The release is tagged 0.131; 0.130 is the rollback version of today's system.

## The two commands

Run as root on the production host, from the live release (`/srv/sim-worlds/production`):

```sh
bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh check    # the preconditions only; changes nothing
bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh switch   # the switch
bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh back     # the rollback, inside the window
```

`/etc/souls/cutover.env` names the world that moves: `SLUG=eden` and `WORLD=<the new system's Eden>`, as
`place-world.sh` placed it.

Before starting the old launcher, install its operator-owned `/etc/souls/cutover-binding.json`:

```json
{"oldWorldId":"<stable old registry worldId>","canonicalSlug":"eden","routesFile":"/var/lib/souls/routes/worlds.json","clientDir":"/usr/local/lib/souls/client"}
```

While Eden is routed (#4177), the launcher writes `v2Stream` (the route's `stream`) into the world page's inline config,
and `v2Bodies` when the binding names it: the same-origin directory serving the v2 body catalogue (`bodies.json`). Rollback
removes both. With an optional absolute `staticDir` (the directory the v2 origin serves as `<stream>static/`), the first
routed page publishes the old world's read-only views there (`scene.json`, `snapshot.json`, `items.json`,
`platforms.json`, `config.json`, `kernel.json`, then `manifest.json`), and the page's reads of them are answered from those
files. `/v1/config` keeps the served client's answer. The page loads the replica (`replica.js`, `replica_bg.wasm`) that
the launcher serves from `clientDir` for the routed world. God edits made on v2 after the switch are not in those files;
the page draws them from the stream (`apps/web/src/v2-engine/creator-kinds.ts`), and a world with none of those files (one
made on the new engine) is drawn from its stream alone (`v2-engine/source/stream-scene.ts`, 0.135 W2). The launcher's user must be able to write `staticDir`.

### One world's old page, on and off (B3-1)

One command switches a world's old page (`apps/web`, as the launcher serves it) to the new engine, and `--back` switches
it back. It writes the binding above, makes the static folder, names the body-assets folder and sets the world's
`canonical` flag in the routes file; a running launcher reads the binding again when it changes (once a second), so no
restart. It never starts or touches a v2 world, the front door or a store.

```sh
node tools/world-launcher/v2-switch.mjs --slug <world> --stream /s/<stream>/ --routes <abs routes.json> \
  --client <abs client dir> --static <abs static dir> --bodies <abs body-assets dir> [--old-world <id>] [--port <launcher port>]
node tools/world-launcher/v2-switch.mjs --back [--slug <world>] [--port <launcher port>]
```

Several worlds (W1, 0.133): one binding file binds a list, `{"schema":"souls/cutover-binding/2","worlds":[<one world's
binding>, …]}`. Eden's one-world file above is read as it is, and stays that form while it binds one world. `--slug`
names the world a run switches: a world not yet bound is added, with the first world's routes, client and bodies folders
unless given, and its own `--static` folder (two worlds never share one). `--back --slug <world>` turns back that world
only. With several bound, `--slug` is required. Each switched world's page names its own route's stream and its own
body path, and publishes into its own static folder. `--stream` is the world's full stream path, from its seed's
`views/world.json`. The launcher's `/__sim/op/cutover` then answers `{configured, worlds: [one world's answer, …]}`, and
`cutover.sh`'s check reads its `SLUG`'s entry.

- `--binding` names the binding file (default as the launcher: `SOULS_CUTOVER_BINDING`, else `/etc/souls/cutover-binding.json`).
- `--old-world` is the world's registry id (default `<slug>-1`, which is what a world without its own id has).
- `--client` holds at least `replica.js` and `replica_bg.wasm` (v2's `target/wasm-load/pkg`), matching the v2 world's
  build. Without the release's `soul-client.json`, the routed `/v1/config` answers 503 and the page uses its inline config.
- `--bodies` is a built body-assets folder (`V2_BODY_ASSETS`, with `bodies.json`). The launcher serves it at
  `/w/<world>/v2/bodies/` while routed, and that is the page's `v2Bodies` unless the binding names another.
- `--stream` must reach the v2 origin on the page's origin (the front door's `/s/` route).
- With `--port`, it reads the world's page afterwards and prints the `v2Stream` and `v2Bodies` the page carries.

While routed the page also names where its owner's box reaches (B3-2b): `v2Gateway`, the world's agent socket path
(the binding's `v2Gateway`, else `/w/<world>/v2/ws`, which the front door sends to the agents' relay) and
`v2Directory`, `/` (the front door sends `/v1/account/*` to the directory). The box exchanges the page's own sign-in
there: Clerk on the stages, the same provider the directory verifies with its `--issuer` and `--parties`.

Run with only `--binding` (or nothing), it switches the bound world on again. `--back` clears only the flag: the next page
names neither field, the published files are removed, the body folder is no longer served and the old world answers.

Locally (fake minds; never against production): a launcher started with `SOULS_CUTOVER_BINDING=<abs file>`, a v2 world
from `worldd seed` and `worldd serve`, `v2/tools/origin/origin.mjs` serving its stream, and Caddy on one port sending
`/s/*` to the origin (`handle_path`) and everything else to the launcher.

The launcher reads `cutover-binding.json` through `/etc/souls`, which the install makes and keeps 751 (it can enter, not list); give the file mode 644 (check: `runuser -u simworlds -- test -r /etc/souls/cutover-binding.json`).

Today's launcher runs as `simworlds`, outside the Souls group, and reads `routesFile` on every Eden write: the install keeps `/var/lib/souls` at 751 and `routes/` at 755 so it can (check: `runuser -u simworlds -- test -r /var/lib/souls/routes/worlds.json`). Unreadable, Eden's writes answer `cutover.activation-unavailable`. Use the resolved old registry identity, including existing aliases, rather than assuming the public slug is the
database identity. The installed client must be the release's matching served bundle. `SOULS_CUTOVER_BINDING` may
name a different binding file; an invalid binding refuses launcher startup. An absent binding leaves ordinary old
operation enabled until one is written (the launcher looks once a second); a binding damaged later keeps the last valid one. Once configured, missing or damaged activation
metadata refuses bound-world mutations by name; unrelated worlds and read-only sockets continue.

`check` asks the actual launcher over its direct loopback operator endpoint, verifies its binding identifier and
the installed client hashes, and checks the same trusted `souls/world-routes/1` file used by the public route map.
The endpoint is unavailable to forwarded requests and discloses no filesystem paths.

**`switch`** runs `check` first and refuses, changing nothing, on any failed precondition (each named): the live release
carries the front door; the directory lists `eden`; `worldd@<world>`, `souls-gateway@<world>` and `souls-agents` (the agents' relay on 7330, #4152) run; the world's
placed socket path is under Linux's 108 bytes; the directory's `--gateway-tokens` is the world folder's `tokens` file
(W11b); the backup and store settings are set; the actual launcher is prepared. Then it:

1. preserves and fsyncs the first old proxy backup and writes `switch` to the fsynced cutover history. Before a fresh
   switch (no journal, or completed rollback), an existing backup must byte-match the current old proxy or refuse;
2. atomically sets only Eden's `canonical` route flag true, fencing old-world mutations before public routing;
3. copies today's feed (`<today's data>/feed.jsonl`, the owner notice among its items) into the new system's
   `/var/lib/souls/news.jsonl`, each line once, which O23's feed serves in today's shape;
4. quiesces the route timer/service and runs O19's SWITCH script, preserving that first backup on retries: the map,
   site files, `caddy validate`, reload and timer. A missing synchronous Eden map is a failed switch;
5. writes `switched`. A routing failure records `switch-failed` and leaves old writes fenced: resume `switch` or
   run `back`; it never silently permits old writes while new routing may be live.

**Order in production:** `souls-agents` is installed (`install.sh`) and running (`systemctl start souls-agents`)
before any Caddy reload that carries a `soul-game.caddy` sending `/w/<slug>/v2/ws`, `v2/creator-token` and
`v2/entries` to 7330. Otherwise every agent gets 502 until it starts (viewers are unaffected). `check` refuses while
it is not active.

**`back`** keeps old writes fenced while it quiesces the route timer/service, restores and reloads the saved old
proxy, confirms the restored file and removes Eden's map entry. Only then does it atomically set Eden's canonical
flag false and write `back`. A partial rollback stays fenced and may be resumed with `back`. Completed switch/back
commands repeat without changes. The last rollback step counts accounts and Souls made since the switch
(`count.mjs`, read-only). No v2 stores, newly created accounts or Souls are removed or copied back.

One exclusive `transaction.lock` directory serializes commands. An existing lock refuses rather than stealing a
possibly live writer's lock. After an interrupted operator process, confirm that writer has stopped before removing
only its stale lock, inspect the durable phase journal, then resume the same command or run `back`. Malformed
journal or activation metadata requires operator repair; never clear canonical to bypass a failed route rollback.

What they change: the proxy's site files, the front door's map and its timer, the cut-over's log and the news file.
Nothing else: no DNS record, no world, no store, no unit of either system. Both systems run throughout; the switch
decides only which of them the public name sends Eden's page to.

## Switching Eden's old page, step by step (0.134 F5-ready)

The switch as it is now (#4210, #4249, #4248, #4250, #4252): the front door already sends streams, a switched world's
gateway and pairing to the new system, and the launcher keeps serving the old page; the switch is one file the launcher
reads (the binding) and one flag (the route's `canonical`). Accounts and Souls are not carried over (pre-release, zero
users): they are saved to one file, then wiped, and owners pair again. Run as root on the production host, in this
order, with Gene's yes. Set once, from the host:

```sh
P=/srv/sim-worlds/production                          # the live release
WORLD=<the new Eden's world name>                     # as place-world.sh placed it (/etc/souls/cutover.env's WORLD)
STREAM=/s/$(node -e "console.log(JSON.parse(require('fs').readFileSync('/var/lib/souls/worlds/worlds/$WORLD/views/world.json','utf8')).stream.replace(/^\//,''))")
STATIC=<a folder the launcher's user can write>       # where the launcher publishes old Eden's static views
LAUNCHER_PORT=<today's launcher port>
```

| Step | Command | Rehearsed |
|---|---|---:|
| 1. Stop the directory (it holds its stores) | `systemctl stop souls-directory` | 0.0 s |
| 2. Save who owns what to one file | `node $P/v2/tools/ops/cutover/souls-state.mjs save --world /var/lib/souls/worlds/worlds/$WORLD --out /var/lib/souls/saved/eden-owners-$(date -u +%Y%m%dT%H%MZ).tar` | 0.1 s |
| 3. Wipe them (refused unless step 2's file holds them as they are) | `node $P/v2/tools/ops/cutover/souls-state.mjs wipe --saved /var/lib/souls/saved/eden-owners-<that time>.tar` | 0.1 s |
| 4. Start the directory on fresh stores | `systemctl start souls-directory` | 0.1 s |
| 5. Switch Eden's old page | `node $P/tools/world-launcher/v2-switch.mjs --binding /etc/souls/cutover-binding.json --slug eden --stream $STREAM --routes /var/lib/souls/routes/worlds.json --client /usr/local/lib/souls/client --static $STATIC --port $LAUNCHER_PORT` | 1.4 s |
| 6. Look in a real browser | open `https://soul.game/w/eden/`: the page draws Eden and reads `$STREAM` (the toolbar shows "Link to this moment") | 6.8 s |
| 7. Switch back, on a stop condition | `node $P/tools/world-launcher/v2-switch.mjs --binding /etc/souls/cutover-binding.json --back --slug eden --port $LAUNCHER_PORT` | 1.5 s |
| 8. The old page is back | open `https://soul.game/w/eden/` again: no `v2Stream`, the old world answers its reads and draws | 7 s after step 7 |

Then copy the saved file to the private state folder on the release owner's machine (it holds tokens; mode 0600, never
committed or attached): `scp <production host>:/var/lib/souls/saved/eden-owners-<that time>.tar .local/project/cutover/`.

- **What `save` keeps** (`v2/tools/ops/cutover/souls-state.mjs`): the directory's account and pairing stores, copied whole
  by SQLite; the gateway's tokens file; the world's `world.json`, `tokens`, `souls.tokens` and `births.json`; and a
  `manifest.json` with each file's SHA-256 and the counts (accounts, Souls paired, the world's Souls). The paths come
  from `/etc/souls/directory.args` (`--store`, `--pairing`, `--gateway-tokens`); `--args` names another file.
- **What `wipe` does:** it checks the saved file holds the stores' rows and the tokens file as they are now, then renames
  each aside (`<file>.wiped-<time>`) and leaves an empty tokens file; the directory makes fresh stores when it starts
  and writes the tokens file again from them. Nothing is deleted, and the world is not touched: its Souls' bodies stay.
  Undoing it is renaming the files back with the directory stopped.
- **Several worlds** (W1): step 5 with another `--slug`, `--stream` and its own `--static` adds that world to the same
  binding; step 7's `--back --slug` turns back only that world.

**The rehearsal.** `node v2/tools/ops/cutover/rehearse-switch.mjs --bin <worldd, gatewayd, directoryd> --pkg <replica pkg>
[--facts <eden facts>]` runs steps 1 to 8 as written on a fresh folder under `.local/`, behind the local front door
(`soul-game.caddy`, as `tools/release/check-0132.mjs` places it), with fake owners (two accounts and a paired Soul) and
a real browser, and prints the table above. Its last run: every step passed, and the old page was back 7 s after
the switch back.

## One writer

- **In the directory.** The new Eden is one world with one claim (its epoch) in the store, made when it was first
  served for the preview. Neither command starts, stops or restarts it, so the switch and the rollback add no claim:
  its history shows one writer at every moment.
- **Across the two systems.** At every moment the front door sends Eden's page to exactly one system (a Caddy reload
  swaps the whole configuration at once). Today's API paths under `/w/eden/v1/` still reach today's launcher by
  O19's design. The actual old launcher resolves aliases and refuses Eden's mutations with `world.new-engine`
  and `node eden.mjs upgrade` guidance before forwarding, checking again after asynchronous waits. Explicit eyes
  gaze requests are mutations too; ordinary views and existing read-only sockets keep running. Active old client
  config/file requests consume the installed manifest and client files as bounded data without redirect or importing
  v2 code into the old runtime. On rollback, the real old config
  carries `x-souls-engine: old`; the v2 upgrade command gives `world.previous-engine` and
  `node eden.mjs upgrade --rollback` guidance before considering the older manifest. R18 restores the kept client,
  local memory and old ownership records without copying world state.

## The declaration

Posted on #2836 and on the feed before the switch, with the minute filled in by the release owner:

> **Eden moves to the new engine on Sunday 22 November** (the switch at `<HH:MM>` UTC).
> The address stays soul.game; no DNS changes. The new Eden has served as a preview for about two hours before it.
>
> **Stop conditions.** The release owner switches back if any of these holds after the switch: the front door's check
> from outside fails (`front-check.mjs --v2 eden`); Eden's page or the directory does not answer for 5 minutes; an
> owner's agent cannot pair or act in Eden; a Soul or the world is stuck or frozen; anything the new system writes is
> corrupt; or Gene says so.
>
> **The rollback** is one command on the production host, `bash /srv/sim-worlds/production/v2/tools/ops/cutover/cutover.sh back`,
> for 24 hours after the switch. It takes under a second in the rehearsal. It points the front door back at today's
> system, which kept running untouched.
>
> **What a rollback loses:** everything done in the new Eden since the switch: its acts, its history, what Souls did
> there. The old Eden carries on from where it stopped at the switch.
>
> **Installed clients on a rollback.** A home that upgraded runs `node eden.mjs upgrade --rollback` and is back on the
> old client inside the window. Until it does, the old world answers it by name, telling it to roll back (R18).
>
> **Accounts and Souls made after the switch** are with the sign-in provider and the new system's stores, and a
> rollback removes neither. A Soul made after the switch does not exist in the old world. They are kept untouched in
> the new system and return at the next switch; nothing is copied back. Their count is the rollback's last line:
> `made since the switch at <time>: <n> accounts, <m> Souls`.

## The switch-day checklist

Before the switch:

- [ ] Gene's yes with the time; the preview has served about 2 hours with no missed bar (A5, the coordinator's).
- [ ] R18 is in today's live release: today's launcher answers Eden's old clients by name, and `upgrade --rollback`
      returns a home to the old client. Without it, do not switch (old clients would keep acting in the old Eden).
- [ ] X15's owner notice (`v2/docs/cutover/soul-owner-notice.md`) is posted on today's feed with
      `node tools/world-launcher/op.mjs feed-post --port <launcher port> --kind announcement --title <its title> --body <its body>`.
- [ ] `install-v2.yml apply` has shipped the origin files (O23's site pages among them).
- [ ] The new system's settings in `/etc/souls/secrets.env`: `SOULS_BACKUP_URL` (the `s3:` form of today's
      `BACKUP_OFFSITE_URL`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SOULS_BACKUP_KEY_FILE`, and
      `DIRECTORY_STORE_URL` (or `WORLDD_STORE`). `check` refuses while any is unset; it never prints a value.
- [ ] The directory's `--gateway-tokens` in `/etc/souls/directory.args` is the Eden folder's `tokens` file
      (`/var/lib/souls/worlds/worlds/<world>/tokens`), so `worldd serve` finds `tokens.souls` (retires and names from
      the owner's page, W11b #3558); otherwise start `worldd serve` with `--directory <that file>`. `check` refuses
      otherwise.
- [ ] Eden is registered in the directory (`register-world`, [install.md](runbook/install.md#an-imported-world-in-the-directory)),
      so `GET /v1/worlds` lists `eden` and the authority map's founder matches the directory's. `check` refuses
      otherwise.
- [ ] The v2 site owner is configured, so `/ops?json=1` answers (not 503 `owner-access-unconfigured`).
- [ ] `/etc/souls/cutover.env` names Eden; `cutover.sh check` passes, and shows the placed socket path's length
      (about 98 bytes of 107).

At the switch:

- [ ] `cutover.sh switch`. Today's feed items, the notice among them, are copied into `news.jsonl` by it.
- [ ] From outside: `node v2/tools/ops/front-check.mjs --v2 eden --today mars-college-2027 --alias eden-2026=eden`.
- [ ] Post the declaration with the minute; walk the real URL (a real owner's agent acts, a real browser watches, one
      uncut clip).

During the 24-hour window:

- [ ] Daily: X15's `node v2/tools/ops/reapproved.mjs --accounts <accounts.sqlite> --pairing <pairing.sqlite>`, posted
      on #2836.
- [ ] On a stop condition: `cutover.sh back`, then post its count line with the rollback's declaration.

## The rehearsal

[`rehearse.mjs`](../tools/ops/cutover/rehearse.mjs) runs both commands twice on a scratch host in one folder under
`.local/`: O18's scratch machine (Eden worlds served by `worldd serve`, their history shipped to a folder store) and
O19's stand-in front door (Caddy in today's layout on loopback), with production's names, paths and ports swapped for
the scratch host's. It records who serves Eden's page every 100 ms, Eden's claims in the store before and after, the
files each command changed and each command's time, and a person who signs up and makes a Soul while switched.

```sh
cd v2 && cargo build --release -p worldd -p gatewayd -p supervisor -p directoryd && cargo build --release -p ops --bin deploy --bin gateway-upgrade
bash tools/ops/install.sh bundle ../.local/bundle target/release <page dist>
cd .. && node v2/tools/ops/cutover/rehearse.mjs --bundle .local/bundle --facts <eden facts.json> --entries content/kinds
```

The facts file is N1's export (`v2/tools/import-eden`).

## Known limits

- The named answer to old clients and open pages, and `upgrade --rollback` into the old world, are R18's (#2821);
  the rehearsal's stand-in for today's launcher has neither.
- The account count reads the account store, which `directoryd` holds while it runs; then `back` says the accounts
  were not counted and why, and the count comes from the store once read (the Souls are counted from the pairing
  store, which is readable).
- A Soul brought over (X11) that its owner approves as a new Soul rather than by id would count as made after the
  switch.

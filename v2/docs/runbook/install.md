# Installing Engine v2 beside today's system

Engine v2 O17 (#2810). One script, `v2/tools/ops/install.sh`, puts the new programs on one Linux machine beside
today's system. It serves nothing public and starts nothing: the preview is a path on the public name that the proxy
sends to these programs once the owner places its site file. Routing between the systems is O19 (`v2/tools/ops/proxy/README.md`); releases are O18.

## What it makes

| What | Where | Owner, mode |
|---|---|---|
| The unprivileged user and group | `souls`, no shell, no home of its own | system user |
| The programs: `supervisor`, `worldd`, `gatewayd`, `directoryd`, `deploy` (O7's, for the runbook's `world-deploy.sh`), `gateway-upgrade` (O16's, for `gateway-upgrade.sh`), `import-accounts` (X11), `import-world` (X6) | `/usr/local/lib/souls/` | root, 755 |
| The viewers' origin (`origin.mjs`, `cache.mjs`) and the page's files (V5) | `/usr/local/lib/souls/origin/`, `/usr/local/lib/souls/web/` | root, 644 |
| Data: worlds, the directory's store, the view tier's stream files | `/var/lib/souls/{worlds,directory,views}` | souls, 750 |
| The directory's arguments, written once, never overwritten | `/etc/souls/directory.args` | root:souls, 640 |
| Secrets, `KEY=value`, written once (empty), never overwritten | `/etc/souls/secrets.env` | root, 600 |
| What the install made (its record; see below) | `/etc/souls/install.state` | root, 644 |
| Units | `souls.slice`, `worldd@.service` (O1) and its drop-in `worldd@.service.d/10-install.conf`, `souls-gateway@.service`, `souls-directory.service`, `souls-origin.service` | root, 644 |

The view tier runs inside each world's process (`worldd`), so it has no unit of its own. Every program runs as
`souls` in `souls.slice`, whose `MemoryMax` is 3 GB; inside it a world may use 2 GB (O1), a gateway 512 MB, the
directory and the origin 256 MB each. The processor and the disk are shared, never capped: the slice's `CPUWeight`
and `IOWeight` are 20 against the default 100, so when both systems are busy the new one gets a fifth of what today's
gets, and all of it when today's is idle; neither system's world time is throttled. `TasksMax` is 4,096. Every unit
runs with `NoNewPrivileges`, `ProtectSystem=strict` (writing only under `/var/lib/souls`), `ProtectHome` and
`PrivateTmp`. Units read the secrets file as root before they drop to `souls`. The directory
and the origin listen on loopback only (ports 7310 and 7320); each world's gateway gets its port from its own
`/etc/souls/gateway-<world>.env`, written when the world is placed (X5).

**Does it fit beside today's system?** Production: 8 cores, 30.6 GB of memory, about 173 GB of disk free. Today's
worlds use 6.3 GB, and their unit may use at most 26 GB (O14, `v2/docs/machines.md`). With the new system's 3 GB
slice that is at most 29 GB of 30.6 GB, 9.3 GB at today's use. Yes.

## How it stays apart

- It starts, enables and restarts nothing; the one systemd call is `daemon-reload` when a unit file changed.
- It never reads or writes today's units, users, data, proxy, DNS or firewall. `install.sh check` (run by CI in
  `v2/tools/ci.sh` and by the workflow) plans into an empty folder and compares every path it would write, and every
  unit, user and port it names, with what today's installer and units name (read from
  `tools/world-launcher/deploy/`): none may be the same or inside one of today's folders.
- It refuses, changing nothing, when anything it would make is already there and is not in its record (exit 3). So
  it never adopts a user, folder or unit it did not make.
- Run again, it changes nothing: each file is written only when its bytes, mode or owner differ; `plan` then prints
  `plan: nothing to change`.
- `uninstall` removes only what the record lists: the units, the drop-in, `/usr/local/lib/souls`, `/etc/souls`
  (the arguments and secrets with it), the user, and `/var/lib/souls`. When `/var/lib/souls` holds any file it keeps
  that folder and what it needs to be used again: the user and group that own it, and `/etc/souls` with the record,
  `secrets.env`, `directory.args` and any `gateway-*.env`; a later `apply` takes them back. Removing the data is a
  production delete, which needs the owner's yes. It refuses, changing nothing, unless every `worldd@` and `souls-*`
  unit is inactive or failed (not running, starting, stopping or reloading) and none is enabled, at boot or for this
  boot only. Per-world drop-ins that later tasks write are theirs to remove.
- A run that stops part-way leaves nothing unrecorded: the record's folder is made first, and the user is recorded
  before it is made, so the next run takes up where it stopped.

## Running it

The release owner runs it through the workflow, from main. Every action builds the programs and the page on the
runner, checks, bundles, and runs the script on the production machine over the deploy key:

```sh
gh workflow run install-v2.yml --ref main                     # the dry run: prints the plan, changes nothing
gh workflow run install-v2.yml --ref main -f action=apply     # makes it so; run again, it changes nothing
gh workflow run install-v2.yml --ref main -f action=uninstall # removes what apply made
```

The plan and the result are in the run's summary. By hand, on the machine, as root, from a bundle
(`bash v2/tools/ops/install.sh bundle <out> <cargo release folder> <page dist folder>`):

```sh
bash <bundle>/install.sh plan --from <bundle>
bash <bundle>/install.sh apply --from <bundle>
bash <bundle>/install.sh uninstall
```

## Installed migration commands

The workflow builds both migration executables from the same checked-out head and locked release build as the
serving programs. They are ordinary files in the recorded `/usr/local/lib/souls` tree, root-owned at mode 755;
installing them does not run an import or start a service. The production machine needs no Rust toolchain.

X11 reads a backup set and writes only a **fresh import output**, separate from the running installation's stores.
Choose an output path that does not exist; do not point it at a serving account store or directory:

```sh
set -e
test ! -e <fresh-import-dir>
/usr/local/lib/souls/import-accounts <backup-set> --out <fresh-import-dir> --json
```

Add `--world <file.db>` for an original world's backup kept outside the set, as described in
`v2/tools/import-accounts/README.md`. Both registries and all world backups open read-only and immutable.

X6 has two steps: export one backup with Node, then validate the facts with the installed Rust executable. From
a checkout of the same source head with its Node dependencies installed (Node 22.18 or later), create a fresh
facts directory and run the existing exporter's permission grants explicitly:

```sh
set -e
mkdir -m 700 <fresh-facts-dir>
node --permission \
  --allow-fs-read=packages/ \
  --allow-fs-read=node_modules/ \
  --allow-fs-read=v2/tools/import-eden/export/ \
  --allow-fs-read=v2/tools/import-world/export/ \
  --allow-fs-read=worlds/core-assets/ \
  --allow-fs-read=<map.json> \
  --allow-fs-read=<backup.db> \
  --allow-fs-write=<fresh-facts-dir>/ \
  v2/tools/import-eden/export/export.ts \
  --backup <backup.db> --map <map.json> --out <fresh-facts-dir>/world.facts.json
/usr/local/lib/souls/import-world <fresh-facts-dir>/world.facts.json --json
```

Use the same explicit backup, map and output paths in the grants and exporter arguments. These are the grants
from `exportArgv` in `v2/tools/import-world/import-world.ts`: read access only to the exporter, content dependencies,
asset index, map and selected backup, and write access only to the fresh facts directory. No network, child-process
or worker permission is granted. SQLite opens the backup read-only and immutable. Repeat these two steps for each
backup (the validator also accepts several facts files). The convenience `import-world.ts` wrapper invokes
`cargo run`; use the installed validator above on production.

## After the install: the owner's steps

1. Configure the public browser fields in `/etc/souls/origin.env`: `AUTH_PROVIDER=clerk`, the matching `CLERK_PUBLISHABLE_KEY` and HTTPS `CLERK_ISSUER_URL`; optional `CLERK_SATELLITE_DOMAIN` and `CLERK_SIGN_IN_URL` keep the existing satellite sign-in. The origin unit reads this public-only file, never `secrets.env`. `/v1/auth/config` exposes only these allowlisted fields with no-store; missing or invalid fields refuse sign-in. Test keys and test-person forms remain restricted to HTTP loopback. No copied session token is needed.

   Add the sign-in provider to `/etc/souls/directory.args` (`--issuer <https origin> --parties <origin,...>`). Only
   the configured origin mounts sign-in (`docs/operations/auth.md`), so the preview lives on the public name.
2. Put any secrets in `/etc/souls/secrets.env`.
3. Place the preview's proxy site file once, by hand; a release never writes the proxy's configuration. The shape,
   for a path under the public name (the path is the owner's choice; `<origin>` is the origin's loopback address
   and port 7320):

   ```caddyfile
   handle_path /v2-preview/* {
     handle_path /s/* {
       reverse_proxy <origin>
     }
     root * /usr/local/lib/souls/web
     file_server
   }
   ```

4. Start units by name when a world is placed (X5): `systemctl start souls-origin souls-directory`.

## Not yet in it

- Sleep and wake (O2, #2731) is not built; the install has no unit for it.
- Log shipping (O3, #2732) runs inside `worldd`; its object-store keys go in `secrets.env` once it lands.
- Pairing (W2, #2705) runs inside `directoryd`; it needs nothing more from the install.

## Private owner overview

The origin serves `/ops` without today's launcher. Its HTML contains only the existing public provider fields;
serving the shell neither loads the snapshot nor contacts another service. Private JSON uses the directory's
existing provider-session endpoint and requires an explicit site-owner account on every request.

Configure these names in the origin's existing `origin.env` (the origin service reads this file):

- `AUTH_PROVIDER`, `CLERK_PUBLISHABLE_KEY`, `CLERK_ISSUER_URL`: the existing production Clerk public settings.
- `CLERK_AUTHORIZED_PARTIES` and `SOULS_OPS_PUBLIC_ORIGIN`: the explicit application origins and exact public
  application origin. The latter must occur in the former and match the directory's provider configuration.
- `SOULS_OPS_DIRECTORY`: the trusted numeric loopback HTTP origin of the directory. The installer records its
  default directory listener; adjust it if that listener changes. No path, credentials, query or fragment is allowed.
- `SIM_SITE_OWNERS`: explicit comma-separated canonical account ids. `CATALOG_GENE_OWNER_ID` remains the
  compatibility fallback only when `SIM_SITE_OWNERS` is empty. Neither setting grants a world-owner fallback.
- `SOULS_DATA`: the existing data location; its `owner-overview.json` is the existing collector's snapshot.

The directory must use the same production provider and allowed application origins. The origin forwards only the
session bearer and configured application Origin to fixed `POST /v1/account/session`; there is no operator, local,
header or test sign-in bypass. It never opens the account store or adds a second verifier. Owner removal and directory
session revocation apply on the next request. No bearer is cached or written; only the bounded snapshot projection
is retained privately, preserving today's last-valid/stale behavior. This change does not install a collector.

Missing or invalid settings or unavailable authority fail closed as `owner-access-unconfigured`; missing/invalid
sessions receive `sign-in` (401), verified non-owners `not-owner` (403), and saturated authority work `busy` (429).
Directory requests have a three-second total bound, two simultaneous slots and a four-KiB response limit, and never
follow redirects. Snapshots remain private/no-store/noindex and are not exposed as a static file. Never put secret
keys, session tokens or credentials in the origin environment file or public auth response.

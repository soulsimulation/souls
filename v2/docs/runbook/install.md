# Installing Engine v2 beside today's system

Engine v2 O17 (#2810). One script, `v2/tools/ops/install.sh`, puts the new programs on one Linux machine beside
today's system. It serves nothing public and starts nothing: the preview is a path on the public name that the proxy
sends to these programs once the owner places its site file. Routing between the systems is O19 (`v2/tools/ops/proxy/README.md`); releases are O18.

## What it makes

| What | Where | Owner, mode |
|---|---|---|
| The unprivileged user and group | `souls`, no shell, no home of its own | system user |
| The programs: `supervisor`, `worldd`, `gatewayd`, `directoryd` | `/usr/local/lib/souls/` | root, 755 |
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

## After the install: the owner's steps

1. Add the sign-in provider to `/etc/souls/directory.args` (`--issuer <https origin> --parties <origin,...>`). Only
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

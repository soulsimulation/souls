# A world restarting

Engine v2 O1 (#2730). Each world is its own process, `worldd@<world>.service`, with its own limits and its own
pinned build, restarted alone and for ever. `<world>` is `<lineage hex>-<zone scope hex>-<zone counter>`.

## How a world runs

- **The unit** is `v2/tools/ops/units/worldd@.service`. `Type=notify`: while it loads, the world says
  `EXTEND_TIMEOUT_USEC=30000000` at each load stage and while it applies its log (at most ten a second), so a long
  load runs as long as it makes progress, and a load with no progress for 30 s (`TimeoutStartSec`) is ended
  (`Result=timeout`) and restarted. Never raise `TimeoutStartSec` or add an override for a slow world: read its
  `start-up: <stage> at <ms>` lines in the journal for the stage that went 30 s without progress (#4013;
  `v2/tools/ops/x5-start-progress.sh` runs both cases under the unit). The world says READY=1 once it ticks, then
  WATCHDOG=1 twice a second while its clock is not wedged. No word for 5 s ends it: a process frozen whole. K7's own
  watchdog inside says a stall (no tick for 0.5 s) in the journal (`watchdog: stalled`) and in `health.json`
  (`stalled`: `now_ms` while it lasts, `ended`, `longest_ms`), and the world runs on: a busy host's pause never
  restarts a world. Only a clock with no tick for 15 s is wedged: exit 86, `tick-stalled`, and a restart.
- **Exit 87, `disk-failed`.** The world's log or text store failed to write (`worldd: disk-failed: <reason>` in the
  journal), so it stopped rather than run on without a record of what happened. It restarts from its log, as after
  any exit. If it keeps coming back, check the disk (free space, read-only mount, errors) and the text store's
  folder. A record over the size limit (`record-size`) also exits 87: read the journal line for the reason before
  blaming the disk.
- **A store that does not answer at the start** (R17). No read of the store ends a world's start. The claim and
  shipping, the history archive's open (its header, bundle index and public history) and the creator's record are
  read on their own threads after the world listens, each tried after 1, 2, 4 … s, then every 60 s, until the store
  answers. The journal says `worldd: <shipping | the archive | the creator's record> waits for the store: <fault>; try
  <n> unanswered, the next in <ms> ms`, and `health.json` has `"shipping"`, `"archive"` and `"creator"`, each
  `{"state":"degraded","fault":…,"tries":…,"next_try_ms":…}` while it waits and `current` once answered. The log on
  the disk is the truth: shipping catches up from it once the store answers, and the compactor keeps the whole log
  until it has. The archive writes nothing until the claim is held. While the creator's record waits, no one is the
  creator and edits are refused; its first try (two reads) holds the start for at most about 10 s. Only a fork's
  archive base is read before listening, tried the same way. A refusal of another kind (not `store-unreachable`) of
  the claim or of an unforked world's archive open (`restart-gap`, another writer's claim, a record that does not
  decode) ends the process by name, `worldd serve: <refusal>`, as before; the unit restarts it and a deploy's canary
  fails `canary.exited`.
- **A degraded public stream** (R12). When the public stream cannot recover from the store (refused or out of reach
  after its patient tries), the world does not exit: it serves its Souls with no viewers (no `views/world.json`) and
  tries again after 1, 2, 4 … s, then every 60 s, until the store answers. The journal says `worldd: the public
  stream is degraded, no viewers: <fault>; try <n> refused, the next in <ms> ms` at each try, and `health.json` has
  `"stream":{"state":"degraded","fault":…,"tries":…,"next_try_ms":…}` (`serving` once it recovers). Fix the store or
  the fault named; no restart is needed. A degraded world does not sleep, and the records it makes meanwhile wait in
  memory until the stream catches up. A stream that ends after serving (a local fault, such as the disk) says
  `"state":"stopped"` with its fault; a restart starts it again.
- **A store that stalls after the stream serves** (R15). Viewers read the stream from the machine's disk. Each part,
  its words, its recovery objects and the chain's head are written there first: the parts under `views/`, the recovery
  chain in the spool `<world>/stream-backup/` (never served, because it holds the world's records). The store gets
  them from the backup thread, behind the stream, so a stall or refusal delays only the backup. The journal says
  `worldd: the public stream's backup is behind, viewers unaffected: <fault>; pass <n> refused, <k> objects wait, the
  next in <ms> ms`. `health.json` has `"stream_backup":{"state":"degraded",…,"behind":<k>}` while `stream` stays
  `serving`. The backup tries again after 1, 2, 4 … s, then every 60 s, for ever, and says `caught up` once the store
  holds the spool's head. Nothing is dropped: the spool holds what the store lacks, bounded only by the disk, as the
  log is (`behind_bytes` says how much). A restart, even after a SIGKILL, recovers the chain from the spool's head,
  so viewers keep the exact bytes they were shown. Do not delete `stream-backup/` on a running machine. A stop
  (SIGTERM) and a sleep give the backup up to 8 s and 3 s to catch up first.
- **A move to a new machine needs `stream_backup` current, or the spool copied with the world's folder.** A world
  that recovers from the store alone (no `stream-backup/`) cuts no part where the store's chain ends. Its first cut,
  once the world has moved past the recovered cursor, starts a new generation whose baseline holds those records, so
  it does not cut a part again at an address viewers may hold. If the store was behind, the parts it lacked are a gap
  in the stream's history. Every generation's baseline carries the epoch of the directory claim it was made under
  (R16), so even where the old machine's lost tail rolled over at the very cursor the new machine moves to, the two
  generations have different addresses. A world that recovers from its spool under a new claim (a restart after a
  crash, a move with the spool copied, even while the old machine still runs) rolls its generation over at once, with
  the hand-off, so its parts never go to an address the old instance cuts; a viewer on the stream crosses with no gap.
  A clean stop (SIGTERM) or a sleep marks the spool (`head.clean`: the machine, the folder and the chain's head), and
  the next start or wake on that machine, in that folder, at that head keeps its generation: no new seed and baseline.
- **`"stream_backup":{"state":"fenced"}`** means the store's chain head is another writer's: an older instance of
  this world still running beside a newer one (on this machine or another). Before fencing, a backup reads the
  directory: the instance holding the world's newest claim writes over the other's head, so only the older one
  fences (R16), even if it goes on writing heads during the overlap: the newer one puts over each at once. The fenced one never writes over it and stops backing up
  for good; its viewers are unaffected. Stop the instance that should not be running. If the
  fenced one is the one that should run (the other is gone for good), unfence it: stop it, remove its confirmed and
  tried heads, and start it; its backup learns the store's head again and writes over it.

  ```sh
  sudo systemctl stop worldd@<world>
  sudo find /var/lib/souls/worlds/worlds/<world>/stream-backup \( -name head.confirmed -o -name head.tried \) -delete
  sudo systemctl start worldd@<world>
  ```

  A spool with no confirmed head, or one written for another store (the stream's store moved to another bucket), is
  learned again the same way by itself; a store whose head is gone gets this writer's.
- **The launcher** (`supervisor launch <world>`, the unit's `ExecStart`) reads the world's pinned build from its
  directory record (W8). The store is the directory's: `DIRECTORY_STORE_URL` (or `DIRECTORY_STORE_*`) in
  `/etc/souls/secrets.env`, which the install's drop-in gives every worldd@, or the folder `$WORLDS_ROOT/directory` on a
  machine without one. W3b's placement and archive read the same store through `supervisor directory-get`. When the store is out of reach it uses this machine's cached
  copy (`$WORLDS_ROOT/cache/<world>`), so an unreachable store holds no world down. It checks that
  `$WORLDS_ROOT/builds/<hash>/worldd` hashes to the pin (SHA-256 of the file, `1220` in front), and runs it as
  `worldd serve --dir $WORLDS_ROOT/worlds/<world>`, the world folder `worldd seed` made and `place-world.sh` placed (C1).
- **Limits per world** go in `/etc/systemd/system/worldd@<world>.service.d/limits.conf`. Never write it by hand: to
  set a world's cap, add its slug to `v2/tools/ops/units/world-limits.json` (`"eden": { "memory_max": "8G",
  "start_within_s": 600 }`) and install a build (`install.sh apply`), which writes the file for each listed world placed
  on the machine (`world-limits.mjs`, slug to instance through the world-authority map) and runs `systemctl
  daemon-reload`; the cap applies at the world's next start. A world not listed keeps the unit's `MemoryMax=2G`, and
  `souls.slice` (12 GB) leaves room for one 8 GB world. `start_within_s` is how long `deploy` waits for the world to
  serve (30 s when not listed). Once a build with this and #4069 is installed on production, the hand-added drop-ins
  `worldd@<Eden>.service.d/40-memory.conf` and `30-start-timeout.conf` can be removed (`systemctl daemon-reload`
  after): `limits.conf` carries Eden's 8 GB, and worldd's start-up progress replaces the raised start timeout.
  There is never a `CPUQuota`: it throttles the clock and slows world time. `MemoryHigh` stays `infinity`: below the
  limit with no swap it throttles a leaking world to a crawl that never reaches the limit (one leak run with
  `MemoryHigh` at 75 % of the limit: no exit in 10 s, the neighbours' tick 99th percentile up 11 and 18 %), a world held slow instead of restarted.
  A world past `MemoryMax` is ended by the kernel (`oom-kill`) and restarted; file cache from log writes is reclaimed
  before that and never ends a world.

## Never held

There is no start limit (`StartLimitIntervalSec=0`), no breaker and no resting state. Every failure is retried, the
delay growing from 100 ms over 10 restarts to 29 s and staying there, for ever. A pin naming a build that is not on
the machine fails `build.missing` (exit 78) and is retried like any other failure: put the build on the machine
(`$WORLDS_ROOT/builds/<hash>/worldd`) and the world serves at its next try, within 29 s. A planned stop or restart
(`systemctl restart`) is no failure.

## The health record

A world that cannot start writes nothing, so the supervisor keeps its own, in `$WORLDS_ROOT/health/`:
`<world>.log` (the restart record: `start`, `ready`, `exit <what>`, `stop`, with times in ms) and `<world>.json`.

```text
bash v2/tools/ops/world-health.sh <world>
```

It runs `/usr/local/lib/souls/supervisor health <world>` with `WORLDS_ROOT=/var/lib/souls/worlds`; without a world's
name, `supervisor health` prints every world's record. A planned stop and start: `bash v2/tools/ops/world-stop.sh
<world>`, `bash v2/tools/ops/world-start.sh <world>`.

`state` is `running`, `starting`, `restarting`, `stopped`, or `restart-loop`: started five times in five minutes
and not serving. `count` is its starts in the last five minutes, `failures` its failures since it last served,
`last_exit` how it last ended (`build.missing`, `build.mismatch`, `pin.missing`, `tick-stalled`, `oom-kill`,
`watchdog`, ...) and `next_try` when the next start is due (ms; systemd's own timer decides, this is its schedule).
Turning `restart-loop` into a message to a person is O15's.

| last exit | what to do |
|---|---|
| `build.missing` | the pinned build is not on this machine: stage it (O18), or pin one that is (O7) |
| `build.mismatch` | `builds/<hash>/worldd` is not that build: put the right file there |
| `pin.missing` | no record in the store and no cached copy: the world was never pinned here |
| `oom-kill` | the world passed its `MemoryMax`: read its last lines in `journalctl -u worldd@<world>` |
| `tick-stalled`, `watchdog` | the clock was wedged, no tick for 15 s: K7's record of the stalled tick is in the journal |

A world is served under its own header, `<world>/header` (K16), the one its log names, never one the build rebuilds;
`header.kinds` beside it keeps each pinned kind's owner. When a build pins a kind at another revision, the start's
`header:` line in `journalctl -u worldd@<world>` lists each kind taken at the world's revision, those the world cannot
make until it is reseeded, and those with no definition here. A start that refuses its header says why:

| refusal | what to do |
|---|---|
| `header-missing` | no `header` file, and the log names another header than this build's: restore the folder's `header` and `header.kinds` from its backup, or reseed the world |
| `header-mismatch` | the `header` file is not the header the log names: restore it from the backup (never hand-edit it), or reseed |
| `world-identity-mismatch` | the `header` (or the folder) is another world's: the folder holds files of two worlds; restore it from this world's backup |

## The runs (O1's proof)

`v2/tools/ops/o1-leak.sh`, `o1-builds.sh` and `o1-crashloop.sh`, as root on a disposable Linux machine with cgroup v2
and systemd 254 or later, never one that runs worlds. Build first (`cargo build --release -p worldd -p supervisor`
and `cargo build -p worldd`), then `O1_BIN=<the cargo target folder> bash v2/tools/ops/o1-leak.sh`. Each prints a
table, two repeats, and exits non-zero when a row misses its bar.

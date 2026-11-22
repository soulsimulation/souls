# A world restarting

Engine v2 O1 (#2730). Each world is its own process, `worldd@<world>.service`, with its own limits and its own
pinned build, restarted alone and for ever. `<world>` is `<lineage hex>-<zone scope hex>-<zone counter>`.

## How a world runs

- **The unit** is `v2/tools/ops/units/worldd@.service`. `Type=notify`: the world says READY=1 once it ticks, then
  WATCHDOG=1 twice a second while its clock is not wedged. No word for 5 s ends it: a process frozen whole. K7's own
  watchdog inside says a stall (no tick for 0.5 s) in the journal (`watchdog: stalled`) and in `health.json`
  (`stalled`: `now_ms` while it lasts, `ended`, `longest_ms`), and the world runs on: a busy host's pause never
  restarts a world. Only a clock with no tick for 15 s is wedged: exit 86, `tick-stalled`, and a restart.
- **The launcher** (`supervisor launch <world>`, the unit's `ExecStart`) reads the world's pinned build from its
  directory record (W8). The store is the directory's: `DIRECTORY_STORE_URL` (or `DIRECTORY_STORE_*`) in
  `/etc/souls/secrets.env`, which the install's drop-in gives every worldd@, or the folder `$WORLDS_ROOT/directory` on a
  machine without one. W3b's placement and archive read the same store through `supervisor directory-get`. When the store is out of reach it uses this machine's cached
  copy (`$WORLDS_ROOT/cache/<world>`), so an unreachable store holds no world down. It checks that
  `$WORLDS_ROOT/builds/<hash>/worldd` hashes to the pin (SHA-256 of the file, `1220` in front), and runs it as
  `worldd serve --dir $WORLDS_ROOT/worlds/<world>`, the world folder `worldd seed` made and `place-world.sh` placed (C1).
- **Limits per world** go in `/etc/systemd/system/worldd@<world>.service.d/limits.conf` (`MemoryMax`, `CPUWeight`).
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

## The runs (O1's proof)

`v2/tools/ops/o1-leak.sh`, `o1-builds.sh` and `o1-crashloop.sh`, as root on a disposable Linux machine with cgroup v2
and systemd 254 or later, never one that runs worlds. Build first (`cargo build --release -p worldd -p supervisor`
and `cargo build -p worldd`), then `O1_BIN=<the cargo target folder> bash v2/tools/ops/o1-leak.sh`. Each prints a
table, two repeats, and exits non-zero when a row misses its bar.

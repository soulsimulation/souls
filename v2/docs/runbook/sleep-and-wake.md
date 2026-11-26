# Sleep and wake

Engine v2 O2 (#2731). A quiet world leaves the machine and is back, time exact, before its next due change or an
intent. That is what lets many quiet worlds share one machine. World time never stops: a sleeping world is not
paused, it has no work until its next due change, and on waking it catches up to now exactly (K9's jump) and commits
each due change at its due time.

## Going to sleep

`worldd serve --sleep <alarm socket>` (the launcher passes `--sleep $WORLDS_ROOT/alarms.sock` only with
`SOULS_SLEEP=1` in the unit's environment, off by default and turned on per world by `sleep-rollout.sh` below; 0.133 S3b,
`worldd/src/sleep.rs`) reads its clock each second: **still** (no intent queued or open, no act forming or checking,
no body moving for an intent or for the wind-down) and its **next due time**, the earliest over its due lists (the
sky's light, day and weather, the bodies' moves and wind-down, the activities and boats, the loose things' ends, the
forms' timers: a bell's fade, a planter's next stage). A form's timer pending when the world sleeps or restarts goes
back on its list from the timers the tree holds, at the first tick (#3991). Still for 60 s on end, with nothing due
within 60 s (`supervisor::sleep::may_sleep`), it sleeps. Agents' sockets live in the gateway and keep no world awake. The order is fixed:

1. its log durable to the last record (a woken world resumes from its newest checkpoint and the records after it, as
   after any restart);
2. its alarm, a real time (its next due change) or `none` (nothing due: only an intent wakes it), sent to the
   machine's alarm daemon, which writes it to the directory and answers `ok`;
3. the public stream's pointer: still until that due time (S4w, `PublicWriter::sleep`; refused `stream-sleep` when
   what it published is not the world's still state, and then the world stays up);
4. exit 75. `worldd@.service` neither restarts it (`RestartPreventExitStatus=75`) nor counts it a failure
   (`SuccessExitStatus=75`).

An alarm not acknowledged (no daemon, the store out of reach) is no sleep: the world stays up and waits another quiet
minute, so no wake is ever missed. An alarm left for a world that stayed up (its stream refused) is harmless: its wake
finds it running.

## The alarm daemon

`souls-alarms.service` runs `supervisor alarms`, one per machine, on `$WORLDS_ROOT/alarms.sock`. It is the one
writer of the machine's alarm record, `alarms/$SOULS_MACHINE` (default `local`) in the directory: one line per
sleeping world, `<world> <due µs from the Unix epoch>` or `<world> none`.

The install (`install.sh apply`, [install.md](install.md)) puts the unit and its drop-in in place, enables it and
starts it. The drop-in keeps the daemon root (it starts `worldd@` units) in the group souls with `UMask=0007`, so its
socket is group-writable and a world or a gateway running as souls can reach it.

- **At start** it reads the record and arms every alarm, overdue first. A daemon killed, or a machine rebooted, loses
  no alarm: an alarm that came due while it was down is fired at once.
- **Early:** a world is started at its due time less the longest wake measured lately and a quarter more (the
  daemon's start to the world's `awake`; a world its unit started says how long its own start took, `awake <world>
  <µs>`, so its first alarm is early enough too; at least 0.5 s) less 80 ms (systemd starts units one at a time, measured 30 to 68 ms each) for each other world due within a second either side of it, and never after a
  world due later than it. Every world whose time has come is started in one `systemctl start` call (one call per
  world took about 20 ms each, 2 s for 100). 100 worlds due in one second are started in order, each up before its
  due change. A world woken early waits; it never commits early.
- **By an intent:** the gateway, started with `--wake $WORLDS_ROOT/alarms.sock --world-name <world>`, holds an
  intent for a world that is away and asks the daemon, once, to wake it (`wake <world>`); the intent goes when the
  world is reachable. A sync request asks the same wake (only an agent sends one, and a Soul's client syncs before
  its first intent, so a Soul arriving at a sleeping world would otherwise wait forever); it is still answered
  `world.restarting`, and the client asks again a few seconds later, when the world is up. A viewer never reaches
  the daemon.
- **Waking** is `systemctl start --no-block worldd@<world>.service` (a world already running is left as it is), or
  with `$SUPERVISOR_WAKE` set, that program run with the world's name.
- **Idle**, it blocks on its queue and reads the wall clock again at least once a second, so a stepped clock moves an
  alarm by at most a second (clock jumps are O10's).

```text
WORLDS_ROOT=/var/lib/souls/worlds /usr/local/lib/souls/supervisor wake <world>   # wake one now
cat /var/lib/souls/worlds/directory/alarms/local                                  # the alarms (folder store)
```

## Turning it on, one world at a time

`v2/tools/ops/sleep-rollout.sh`, as root on the host, from the release's checkout. Sleep is on for a world when its unit
has `SOULS_SLEEP=1` (the drop-in `worldd@<world>.service.d/60-sleep.conf`) and its gateway has `--wake`; worlds
placed before 0.133 have neither, and a world with the first and not the second could never be woken by an intent, so
the script sets both or neither. `<world>` is the placed instance or its slug in the authority map.

```sh
bash v2/tools/ops/sleep-rollout.sh plan release-probe        # every world's state, and what apply would change
bash v2/tools/ops/sleep-rollout.sh apply release-probe       # sleep on for that world alone
bash v2/tools/ops/sleep-rollout.sh check                     # exit 1 when a world is half set, down and not asleep,
                                                             # or has sleep on without a healthy alarm daemon
bash v2/tools/ops/sleep-rollout.sh undo release-probe        # always on again
```

- **apply** installs the alarm daemon when it is not installed: given `--from` and the release's bundle after the
  world, it runs that bundle's `install.sh apply` (once a machine), else it stops there, changing nothing. Then it refuses, changing nothing, unless the daemon is healthy: active, not restarting, its socket group-writable and
  answering. It backs up the world's gateway settings under `/etc/souls/sleep-rollout/<world>/<time>/`, writes the
  drop-in, adds `--wake <alarm socket> --world-name <world>` to `GATEWAYD_ARGS`, and restarts the gateway, then the
  world (it resumes from its checkpoint and catches up), checking each stays up. A failed step puts the settings back
  and restarts both. Run again, it changes nothing.
- **undo** puts the last backup back, removes the drop-in and restarts both: a sleeping world is started. The alarm
  daemon stays (other worlds may sleep), and an alarm it holds for that world is harmless.
- **Order on production:** after the release that carries it, `release-probe` first, then `check` and one wake timed
  (a test Soul's intent while it sleeps, [test-souls.md](test-souls.md)); then the other worlds one at a time.
- **The local run:** `v2/tools/ops/tests/sleep-rollout-e2e.sh` (header lists its builds) runs plan, a refused apply,
  apply, check and undo on two local worlds, with imported Eden as the one that sleeps. Measured on a laptop (24 Nov
  2026): Eden slept 56 s after its restart; a test Soul's say while it slept was answered with a receipt in 1.87 s;
  world time less wall time moved 0.6 ms (the pointer's millisecond anchor) across the sleep and wake.

## The runs

`v2/crates/supervisor/runs/sleep-and-wake.sh`, as root on a disposable Linux machine with systemd 254 or later and
cgroup v2 (never one that runs worlds), with `O1_BIN` a cargo target folder holding `release/supervisor` and
`release/examples/sleeper` (`cargo build --release -p supervisor --examples --bin supervisor`). The world is the
stand-in `examples/sleeper.rs` (a due list and nothing else), installed as a build and pinned, so the real unit,
launcher and daemon run it. Each mode prints a row per repeat and exits non-zero when a row misses its bar:

- `quiet`: 100 worlds asleep 10 minutes (no world process, no start, the daemon under 0.5 % of a core), then 100
  alarms 1 s apart, each due change committed within 1 s;
- `burst`: 100 due in one second;
- `kill`: as `burst`, the daemon killed with SIGKILL mid-sleep;
- `intent`: 10 worlds asleep with nothing due, each woken by `supervisor wake`, until it serves;
- `arm`, then reboot the machine, then `check`: 100 asleep across a reboot.

A real world (0.133 S3b): `v2/crates/supervisor/runs/real-world-sleep.sh`, on any machine (the daemon starts the
world through `SUPERVISOR_WAKE`), runs imported Eden with 3 Souls and no agent acting, the wind-down's clocks
shortened: it prints each start, sleep and alarm, how late the first write came after each alarm's due time, and one
agent's wave sent while the world sleeps.

## Known limits

- **A world's start is part of an intent's answer.** Imported Eden starts in about 1.5 s on a laptop (0.133 S5: its
  prepared facts kept in `facts.courses`, the town assembled from one parallel cut, the checkpoint read while the
  facts load), 2.4 s on a loaded one, so an intent to a sleeping Eden was answered in 2.75 s. With its body catalogue
  (large and giant classes) it starts in about 2.6 s (0.133 S12: each class's ground cut once, beside the standard
  one, the planner given a copy). A world's first start after its facts, entries or build change is slower (about
  4.4 s for Eden): it prepares its facts again. `worldd seed` keeps them for its own build, so a freshly seeded
  world's first start does not.
- "Nothing unshipped" (O3) before a world sleeps is not checked yet.

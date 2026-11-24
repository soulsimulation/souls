# Deploy and roll back one world

Engine v2 O7 (#2804). A new build reaches one world at a time, by that world's pin, and a bad one is taken back by
the machine, not a person. The code is `v2/crates/supervisor/src/deploy.rs`; the command is `deploy`
(`v2/tools/ops/src/deploy.rs`). How a world runs and restarts: [world-restarting.md](world-restarting.md).

## What a deploy does

1. **Rehearse on a scratch copy.** The world's folder (`$WORLDS_ROOT/worlds/<world>/`) is read, never written: its
   `world.json`, `facts.json`, `moves.json` and `entries/`, and all but the last `--records` records of its `log` (the
   first, the import's part, always), are copied to `$WORLDS_ROOT/rehearsals/<build>/`, and the new build is started
   on that copy as the launcher starts it, `worldd serve --dir <scratch> --socket <scratch>/gateway.sock`, with
   `WORLDD_REHEARSAL=1` (its output goes to `<scratch>/worldd.err`) and otherwise only `PATH`, `HOME`, `TMPDIR`,
   `LANG`, `LC_ALL`, `TZ`, `RUST_LOG` and `RUST_BACKTRACE` from the deploy's environment: no store, backup, socket,
   pin or service-manager settings reach it, so it never claims the live world or writes its archive, whatever build
   it is. It must serve within the world's start bound
   (below). It is then fed the intents the last records took (I4's answered rows), one tick's group at a time, and must give every
   one a named end, then answer the probe (below). Invariants, not hashes: two builds fed the same intents need not
   write the same bytes. A failed rehearsal leaves the pin where it was.
2. **Canary.** The pin in the world's directory record is set to the new build (one conditional write, W8) and the
   world is restarted (`systemctl restart --no-block worldd@<world>`). It must serve its socket within the world's start bound
   (a real world loads its facts and replays its log): `start_within_s` from `world-limits.json`, which the install
   writes into the world's `limits.conf` as `WORLD_START_WITHIN_S` (Eden 600 s), else 120 s, room for a start whose
   store is slow (R17). A world that hangs fails at that bound as `canary.not-serving`; one whose process ends while
   the canary waits (systemd's `NRestarts` rises) fails at once as `canary.exited`. It must then
   answer the probe within 2 s, every 0.5 s, for `--window-s` (default 60). The first miss is the fault, by name:
   `canary.not-serving` (it does not start, or dies), `canary.exited`, `canary.unanswered` (its clock does not tick),
   `canary.refused: <reason>` (it refuses the probe).
3. **Roll back on a fault, by itself.** Code rolls back, data never. If the new build wrote any record, the old build
   must read every schema the new one writes (each build prints them: `worldd schemas`), or the rollback is refused
   `rollback.schema-unread` and the world keeps running the new build: a person decides then. Otherwise the pin goes
   back, the world restarts, and the deploy ends when the old build answers the probe.

**The probe** owns one temporary operator body, separate from every user's Soul (O18d, #3575). Its unpaired
identity enters through ordinary C3/K10 `life:join`, then sends ordinary `eden:describe` to its own body. A sample
passes only with the exact actor and sequence, a successful receipt with an intent id and nonempty committed entry
references. A root-hash response alone, or a candidate refusing acts, fails. The ordinary admission, ownership and
geometry checks still apply. The operator is not paired or added to the user directory.

Every watch ends by retiring its body with ordinary `life:leave`, including failure and rollback. Before sending,
`deploy` atomically syncs its owned actor, monotonic sequence and pending phase to
`$WORLDS_ROOT/deploys/<world>.probe`; it clears that receipt only after verified retirement. A stable sibling
`<world>.probe.lock` prevents concurrent deployments from sharing the actor. If the operator process is interrupted,
the next watch recovers the same pending identity, confirms any uncertain birth through an idempotent join, and
retires it before starting a new sample. An unavailable or refusing candidate leaves the receipt named
`canary.probe-pending` until the rolled-back healthy endpoint can retire it. Do not delete a pending receipt to
silence that failure. Scratch rehearsal uses its own operator receipt and body on the copied world.

Agents' sockets are the gateway's (I1): they stay open through every restart, intents sent while the world is away
are answered `world.restarting`, and those the world had not answered are sent again when it is back. Every act the
bad build answered is in the log, which the old build reads on its start.

## Commands

```sh
bash v2/tools/ops/world-deploy.sh <world>     # the installed worldd, staged and deployed; prints the undo
bash v2/tools/ops/world-rollback.sh <world>   # back to the build that deploy left
```

The wrappers call the `deploy` program as `deploy <world> <build hash> [--window-s 60] [--records 200]` and `deploy
rollback <world> <to hash> --from <hash>`. `world-deploy.sh` takes the build from the install
(`/usr/local/lib/souls/worldd`, staged under its hash) and the build it leaves from the world's pin (`deploy pinned
<world>`), which it keeps in `$WORLDS_ROOT/deploys/<world>` for `world-rollback.sh`. The install puts `deploy` in
`/usr/local/lib/souls`. `release.sh` uses the same probe.

The world's socket is the placed world's `/var/lib/souls/run/<world>.sock` (`place-world.sh` gives it to the unit as
`WORLDD_SOCKET`), or `<world folder>/gateway.sock` on a machine with no `run/` beside `$WORLDS_ROOT`.

`deploy` prints the timeline (ms from its start), then `Kept`, `RolledBack { fault }`, `NotDeployed { why }` or
`Refused { why }`; it exits 0 only for `Kept`. `deploy rollback` takes a world back by hand, with the same schema check
(it assumes the build being left wrote records), and refuses `rollback.wrong-from`, changing nothing, unless the
world is pinned to `--from`; `rollback-v2.yml` runs it ([release.md](../release.md)). Put the build on the machine first
(`$WORLDS_ROOT/builds/<hash>/worldd`, `supervisor hash <file>` for its hash).

## The proof run

`o7-run --dir <empty folder>` (`v2/tools/ops/src/run.rs`) runs it all on one machine with no systemd: it plays
systemd's part (`supervisor launch` again 100 ms after an exit; a restart is a kill). 100 agents act through
`gatewayd` throughout while three planted builds (`o7-plant`: dies at start, clock stalls, refuses every act, each
only when served, so each passes its rehearsal) are deployed and rolled back, a good build is kept, and a rollback to
a build that reads only an older schema is refused. It prints the timelines, socket counts and how every act ended.

## Known limits

- A rehearsal replays the copied log from its start (the folder's checkpoints are not copied): a long-lived world's
  rehearsal start grows with its log, and must stay under the world's start bound.
- `deploy` against systemd has not been run on a Linux machine: it was proved on `scratch.sh`'s machine (O18, O18b).
  `o7-run`'s builds were renamed to `worldd serve`'s socket and log, and it has not been run again since.
- The canary watches the world through the probe; there is no auditor to watch yet.
- One rehearsal of a build at a time per machine: its scratch folder is named by the build alone.

# Deploy and roll back one world

Engine v2 O7 (#2804). A new build reaches one world at a time, by that world's pin, and a bad one is taken back by
the machine, not a person. The code is `v2/crates/supervisor/src/deploy.rs`; the command is `deploy`
(`v2/tools/ops/src/deploy.rs`). How a world runs and restarts: [world-restarting.md](world-restarting.md).

## What a deploy does

1. **Rehearse on a scratch copy.** The world's log (`$WORLDS_ROOT/worlds/<world>/world.log`) is read, never written:
   all but its last `--records` records are copied to `$WORLDS_ROOT/rehearsals/<build>/world.log`, and the new
   build is started on that copy as the launcher starts it (`worldd --dir <scratch>`, with `WORLDD_REHEARSAL=1`). It
   is then fed the intents the last records took (I4's answered rows), one tick's group at a time, and must give every
   one a named end, then a receipt for the probe act. Invariants, not hashes: two builds fed the same intents need not
   write the same bytes. A failed rehearsal leaves the pin where it was.
2. **Canary.** The pin in the world's directory record is set to the new build (one conditional write, W8) and the
   world is restarted (`systemctl restart --no-block worldd@<world>`). It must serve its socket within 10 s and give
   the probe a receipt within 2 s, every 0.5 s, for `--window-s` (default 60). The first miss is the fault, by name:
   `canary.not-serving` (it does not start, or dies), `canary.unanswered` (its clock does not tick),
   `canary.refused: <reason>` (it refuses the probe).
3. **Roll back on a fault, by itself.** Code rolls back, data never. If the new build wrote any record, the old build
   must read every schema the new one writes (each build prints them: `worldd schemas`), or the rollback is refused
   `rollback.schema-unread` and the world keeps running the new build: a person decides then. Otherwise the pin goes
   back, the world restarts, and the deploy ends when the old build gives the probe its receipt.

Agents' sockets are the gateway's (I1): they stay open through every restart, intents sent while the world is away
are answered `world.restarting`, and those the world had not answered are sent again when it is back. Every act the
bad build answered is in the log, which the old build reads on its start.

## Commands

```sh
# The probe file holds one intent (T10's bytes): an act a healthy world answers with a receipt.
deploy <world> <build hash> --probe <file> [--window-s 60] [--records 200]
deploy rollback <world> <to hash> --from <hash> --probe <file>
```

`deploy` prints the timeline (ms from its start), then `Kept`, `RolledBack { fault }`, `NotDeployed { why }` or
`Refused { why }`; it exits 0 only for `Kept`. `deploy rollback` takes a world back by hand, with the same schema check
(it assumes the build being left wrote records). Put the build on the machine first
(`$WORLDS_ROOT/builds/<hash>/worldd`, `supervisor hash <file>` for its hash).

## The proof run

`o7-run --dir <empty folder>` (`v2/tools/ops/src/run.rs`) runs it all on one machine with no systemd: it plays
systemd's part (`supervisor launch` again 100 ms after an exit; a restart is a kill). 100 agents act through
`gatewayd` throughout while three planted builds (`o7-plant`: dies at start, clock stalls, refuses every act, each
only when served, so each passes its rehearsal) are deployed and rolled back, a good build is kept, and a rollback to
a build that reads only an older schema is refused. It prints the timelines, socket counts and how every act ended.

## Known limits

- The served world here is `worldd gateway-link` (I4's world) started by a build script that maps `--dir` to it; the
  launcher's own `worldd --dir` still runs K7's clock. `deploy` against systemd has not been run on a Linux machine.
- The canary watches ticks and acts through the probe; there is no auditor to watch yet.
- A world's socket path is `$WORLDS_ROOT/worlds/<world>/w.sock`, about 100 bytes under `/var/lib/souls/worlds`: at
  the limit of a local socket's path (104 bytes on macOS, 108 on Linux).
- One rehearsal of a build at a time per machine: its scratch folder is named by the build alone.

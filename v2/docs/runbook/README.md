# Engine v2 runbook

Engine v2 O13 (#2829). The situations an operator of the new system meets, in the order they meet them: one line
each, with what you see, the one command, and the page that says what you then see and how to undo it. Read the
page before you run its command.

Every command is a script in `v2/tools/ops` that takes only `<world>`, the world's name (`<lineage hex>-<zone scope
hex>-<zone counter>`, as `supervisor health` lists it). Run it from a checkout of the repository on the machine that
holds the world, as root, after the install ([install.md](install.md)): it calls the installed programs, reads
worlds under `/var/lib/souls/worlds`, and prints the exact command that undoes it. There is no shell variable to set
first. `--help` says what a script does; `SOULS_OPS_DRY=1` in front prints what it would run instead of running it.
Never run a drill (each page's last section) on a machine that serves worlds.

| # | Situation | What you see | The command | Page |
|---|---|---|---|---|
| 1 | You are told a world is in trouble | a message naming the world and `down`, `stalled`, `lag` or `restart-loop` | none: the message is the watcher's; go to 2 | [alerts.md](alerts.md) |
| 2 | Read a world's health | its state: `running`, `starting`, `restarting`, `stopped` or `restart-loop` | `bash v2/tools/ops/world-health.sh <world>` | [world-restarting.md](world-restarting.md#the-health-record) |
| 3 | A world restarting in a loop | `state: restart-loop`, and `last_exit` names why | the fix in the page's table for that `last_exit`; then 2 again | [world-restarting.md](world-restarting.md#the-health-record) |
| 4 | Stop and start a world | 2 says `running`, or `stopped` | `bash v2/tools/ops/world-stop.sh <world>`, then `bash v2/tools/ops/world-start.sh <world>` (a planned stop is no failure and no alert) | [world-restarting.md](world-restarting.md#never-held) |
| 5 | Deploy a build to one world, and roll it back | the deploy prints `Kept`, `RolledBack { fault }`, `NotDeployed { why }` or `Refused { why }` | `bash v2/tools/ops/world-deploy.sh <world>` (the installed `worldd`); undo: `bash v2/tools/ops/world-rollback.sh <world>` | [deploy-and-roll-back.md](deploy-and-roll-back.md#commands) |
| 6 | Move a world to another machine | a pause under half a second; the directory's epoch names the new machine | the drill only, so far: `bash v2/tools/ops/o9-move.sh` on a machine with no worlds | [move-a-world.md](move-a-world.md) |
| 7 | Read what a world costs | dollars per world per day, by part, then "unused" and the machine | `bash v2/tools/ops/world-cost.sh <world>` | [read-the-cost.md](read-the-cost.md#read-the-page) |
| 8 | A machine lost: bring back what is not in the log | accounts sign in, agents reconnect, words read, removals hold, uploads serve; at most five minutes lost, counted | the drill only, so far: `bash v2/tools/ops/backup/o20-drill.sh` on a machine with no worlds | [restore-stores.md](restore-stores.md) |

## Background, read once

Background, not operator commands: these pages explain how the system works, and their commands are drills and
the install's, run by the release owner. `node v2/tools/ops/runbook-check.mjs` checks every other page.

- [install.md](install.md): what the install put where, and the owner's steps after it.
- [log-shipping.md](log-shipping.md): how each world's log reaches the bucket, and its two marks.
- [mcp.md](mcp.md): the MCP endpoint that apps which take only a URL use to run a Soul.
- [limits-run.md](limits-run.md): the limits run (0.133 P3), measured once on the production machine after every world has moved.

## Not here until its task merges

Each adds its own row when it lands: sleep and wake (O2, #2731), visitors' page errors (O25, #3336), a placed world
served behind the gateway (C1, #3365), a full disk and a bucket out of reach (O10, #2806), restore from the archive
(O12, #2807), a gateway upgrade (O16, #2809), a release (O18, #2811) and the front door (O19, #2830).

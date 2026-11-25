# Upgrading the gateway

Engine v2 O16 (#2809). The gateway (`gatewayd`, one per world, `souls-gateway@<world>.service`) holds every agent's
socket so that a world can restart under them ([world-restarting.md](world-restarting.md)). Its own build is replaced
by a restart: agents reconnect, and lose nothing. Each is back and current within seconds, and no act is lost or
doubled.

## How it works

- **Reconnect, not hand-over.** On SIGTERM (systemd's stop) the gateway stops accepting, closes each signed-in socket
  with **1012** (Service Restart) and exits, within 2 s at most. systemd then starts the new build on the same port.
  A gateway killed outright (SIGKILL, a crash, the kernel's OOM) closes nothing; systemd starts it again after
  `RestartSec=1s`, and the agents see their sockets end.
- **The gateway keeps nothing a new one does not rebuild.** Tokens are read again from the world's tokens file
  (hashes only). The intents it held for the world, the frames kept for a resume and the view subscriptions go with
  the process.
- **The client carries what was in flight.** A client whose socket ends:
  1. waits a random time inside 2 s, then reconnects, again every 50 to 250 ms while the port refuses it (1,000
     reconnects at once would be a flood);
  2. signs in with its cursor (the newest version it applied, and how many frames at it). A new gateway holds nothing
     to resume from, so the answer is `stream.cannot-resume`: the client compares by hash (R5b) and carries on;
  3. sends again, **under its old sequence number**, every intent it has no answer for. The world answers a repeat
     with the answer it had, from its log (I4), so an intent the old gateway lost is answered once, and one already
     answered is answered the same way again, never twice committed;
  4. keeps its cursor moving forward only: a repeat's answer carries the version of its first commit;
  5. treats `world.restarting` as the gateway's own answer, not the world's: it sends the intent again shortly after.

  The served Soul client (`v2/client/src/daemon/daemon.mjs`) sends each intent at most once and does not do step 3.
- **The world hands on what the old gateway can no longer take.** Each gateway connection to the world begins with a
  handover ask (`{31: []}`). An act still going when its gateway went (a walk across the town) ends after the
  restart; the world sends its answer to the newest gateway connection, or holds it until one asks
  (`worldd::handover`), and the new gateway passes it to the Soul's socket once (`gatewayd` `world_link`). On SIGTERM
  the gateway lets the world go before it closes the sockets, so answers in those last moments go to the next gateway
  too.
- **Never in the same step as a world's deploy.** `deploy` holds the machine's step (`$WORLDS_ROOT/step.lock`)
  shared while it runs; `gateway-upgrade` takes it exclusive and refuses `gateway-upgrade.world-deploying` while any
  world deploys, and a deploy refuses `deploy.gateway-upgrading` while the gateway is upgraded.

## Commands

```sh
# On the machine, as root, after the install put the new gatewayd in place: every world's gateway onto it, in turn.
bash v2/tools/ops/gateway-upgrade.sh
```

It runs the installed `gateway-upgrade <new gatewayd> <world> [<world> ...]` with the install's
`/usr/local/lib/souls/gatewayd` and every world under `/var/lib/souls/worlds/worlds/`. It prints its timeline (ms from its start), then `upgraded`, or `refused: <name>` and exits 1:
`gateway-upgrade.world-deploying` (a deploy runs: wait for it), `gateway-upgrade.restart-failed: <unit>` or
`gateway-upgrade.not-active: <unit>` (the new build did not come up within 10 s: put the old one back with the same
command after putting the old bundle back). The build is installed once for the machine
(`/usr/local/lib/souls/gatewayd`), so a world's gateway that restarts on its own afterwards also runs the new build:
the script names every world the machine serves. A release (O18) runs the same program from its own staged build.

## The proof run

`o16-run` (`v2/tools/ops/src/gateway_run.rs`) runs one world (`worldd gateway-link`, I4's world with one toggle per
agent), its gateway, and one scripted client per agent of a schedule from the shared shapes
(`v2/tools/driver/loads.mjs`: `target-even` is even, `target` uneven). The gateway is upgraded (SIGTERM, then the new
build) at 20 s and killed (SIGKILL, back after 1 s) at 40 s. It prints each event's row (agents current within 5 s,
and the time from the event to current: p50, p99, slowest) and the intents' row (each intent's answers from the
world, and every acknowledged intent among the log's answered rows).

```sh
bash v2/tools/ops/o16-run.sh     # builds, writes the uneven schedule, runs it (scratch in .local/o16-run)
```

On Linux, `bash v2/tools/ops/o16-run.sh --systemd` runs the gateway as a `souls-gateway@o16` unit of the machine's
systemd instead: the upgrade is `gateway-upgrade.sh` (`systemctl restart`) and the kill `systemctl kill -s KILL` (the
unit's `Restart=always`, `RestartSec=1s`). It uses the user's manager (`systemctl --user`; gateway-upgrade reaches it
through a `systemctl` on its PATH that adds `--user`), or the system's through sudo with `O16_SYSTEMD=system`.
`O16_AGENTS` sets the agents. The `gateway-linux` workflow runs it on the shared build machine's runner (100 agents,
two repeats) when a pull request changes the run or the upgrade, or by hand.

## Known limits

- One gateway per world, so an upgrade has a gap of a few hundred ms in which the port refuses; the clients' retry
  covers it. Two gateways drained in turn, or systemd's descriptor store, would close the gap; neither is needed for
  the 5 s bar.
- A proxy in front (Caddy today, a CDN later) ends the sockets when it restarts too; the client's reconnect is the
  same.
- The proof's clients compare one level of hashes after `stream.cannot-resume` (the scope's roots and the version);
  a client with a large copy descends further, which the same steps cover (R5b).
- `gateway-upgrade` has run on a Linux machine with systemd (the shared build machine's runner, systemd 245, the user's
  manager) under 100 agents, two repeats, 23 Nov 2026 (0.133 S1): every agent current within 5 s after the upgrade
  and after the kill, every intent answered once. Not yet as root against the install's own units on a serving machine.

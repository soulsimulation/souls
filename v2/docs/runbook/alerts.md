# Alerts: someone is told when a world is in trouble

Engine v2 O15 (#2808). A watcher off the machine messages the owner when an awake world's clock stops, its lag grows,
or the machine is gone: one message when it starts, one when it ends, nothing in between. It reports; it restarts
nothing (the supervisor restarts worlds, [world-restarting.md](world-restarting.md)).

## The two halves

- **The look, on each machine:** `v2/tools/ops/watch/look.mjs` answers `GET /ops/watch` from files only, so no look
  wakes a world. It reads the worlds this machine knows of, the supervisor's record of each (O1), each world's health
  file (O4, written every 2 s by a thread that outlives a stuck clock) and the directory's alarm record (O2,
  `alarms/<machine>`): a world the directory calls asleep is healthy, and so is a stopped one (a planned stop). With
  `WATCH_TOKEN` set in its environment, a look needs that token as a bearer.

  ```text
  WATCH_TOKEN=... node v2/tools/ops/watch/look.mjs --root /var/lib/souls/worlds --port 8091
  ```

- **The watcher, off the machine:** `v2/tools/ops/watch/watch.mjs`, run each minute by any scheduler on another
  machine (a timer, cron, a hosted function), or kept running with `--every 60`. A watcher on the machine would die
  with it. GitHub's scheduled workflows run every 5 minutes at best, late under load: not a home for it.

  ```text
  node v2/tools/ops/watch/watch.mjs --instances instances.json --state watch-state.json --sink discord-dm
  ```

  `instances.json` is `{"instances": [{"name": "<short name>", "url": "https://<machine>/ops/watch", "token_env":
  "<VAR>"}]}`; the token lives in that environment variable, never in the file.

## What is trouble

| code | an awake world whose... |
|---|---|
| `down` | health file is missing or older than 10 s: the process is gone or frozen |
| `stalled` | health file was rewritten between two reads 2.5 s apart and no tick was counted |
| `lag` | oldest queued item is older than the declared bound, 5 s (`--lag-bound-ms`; a tick's budget is 50 ms) |
| `restart-loop` | supervisor gave up serving it: five starts in five minutes |

The instance itself is trouble when its look does not answer in 8 s, or answers anything but a list of worlds.

## When a message is sent

Each run looks three times, 10 s apart. A check failing on all three looks is down; passing on all three, up;
anything else keeps what it was. So:

- trouble that lasts is told within two minutes (a run each minute, about 30 s a run), and so is its end;
- a deploy's restart heals inside 20 s and is told nothing; a planned stop and a sleeping world are healthy;
- one message per change: a run's new troubles in one message, its recoveries in another, nothing while a check
  stays down. A message that fails to send is sent again on the next run.

## Where messages go

- `--sink discord-dm`: today's delivery, a bot's direct message to the owner. `DISCORD_BOT_TOKEN` and
  `DISCORD_USER_ID` come from the watcher's environment (a secret store), never from the repository.
- `--sink file:<path>`: one JSON line per message, for tests.

Before it is relied on, the owner's checklist: where alerts go, and one test that a message reaches a person (stop a
test world's look server for two minutes and see the message arrive, then its recovery).

## Seeing the watcher itself

A watcher that dies is silent. Each look writes `$WORLDS_ROOT/watcher.json` (`at_unix_ms`), and the site owner's
health page (O21, `/ops/health`) shows it in each world's Watcher row: a time more than a couple of minutes old means
the watcher has stopped looking. The watcher's own last run is in its state file (`last.at`, what it saw, what it
sent).

## The proof run

`node v2/tools/ops/watch/drill.mjs --dir <empty folder>`, about 8 minutes on any machine: two test instances with
stand-in worlds, the watcher each minute with the file sink. It prints each message's delay from its event and the
silences, and exits non-zero when a message is missing, late (over 120 s) or extra. The fast checks are
`node --test v2/tools/ops/watch/watch.test.mjs`.

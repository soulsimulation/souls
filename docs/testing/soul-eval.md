# Soul Client eval

`tools/playtest/eval/` measures how well an agent drives one Soul through the world's served client (#1752). It runs a fixed
battery of plain owner instructions and reports, per instruction, whether the body did it, and what that took. It is
never part of CI.

## What one episode is

One episode is one instruction to one fresh Soul on its own fresh world:

1. **A fresh world.** A local episode boots a fake-mind world from the battery's template (Eden 2026), on its own data
   directory. Episodes don't share crowding, context or budget. Each world keeps its own model budget (default $0.50 a
   day).
2. **Folder setup.** The harness sets the folder up as an owner would. It fetches the world's served `eden.mjs` and
   `skill.md`, runs `register` and `create`, and turns on the client's own trace: `.eden-report-on` in the Soul's runtime
   folder, which writes `.eden-report.jsonl`, `soul-trace/1`. Then it starts `serve`. None of this is measured.
3. **Kickoff.** The seat gets one kickoff turn: "read skill.md, then start listening". The arena wake loop then plays
   Claude Code's background `listen`.
4. **The instruction.** The instruction goes in as an owner message through the owner inbox, as the Soul's web card sends
   it.
5. **The observer.** An observer reads the public Soul view (`/v1/edge/public/souls/<id>`) and the owner card every
   500 ms. The episode ends when the item's check holds and the card closes, or the check holds for 15 s, or the card
   closes with the check unmet (after 10 s of grace), or the item's timeout.

**Success** comes from the world only: the body's place (`placePath`), its posture, its receipts since the message, and the
card's state. It never comes from the agent's words. A refusal item passes on an honest `failed` card, or on the body at
an offered alternative. It fails on a `done` with the body somewhere else.

## Per instruction

| Measure | What it is |
|---|---|
| ok | the item's check, n of N repeats |
| turns | model turns from the owner message on (wakes included) |
| API calls | distinct assistant messages in those turns |
| world calls | the client's own HTTP requests, long polls left out (counted separately) |
| CLI calls | `node eden.mjs <command>` calls in the seat's transcript, by command |
| first motion | the owner message to the first observed change of place, posture or a moving receipt, at the observer's 500 ms resolution |
| success at | the owner message to the first sample from which the check held to the end |
| client and server ms per call | `durationMs`, and `serverMs` from `Server-Timing`, the mean over non-long-poll calls |
| refusals | `accepted: false` answers and HTTP errors, by code |
| tokens | in (input, cache reads and cache writes) and out; cost is the CLI's own figure |

Totals give the median and min to max over episodes. The report also folds every call by route, with its #1750 level:
50 ms for bookkeeping, 100 ms for reads, 150 ms for an act's acknowledgment. Long polls hold their answer by design, so
they get no level.

## Commands

```sh
# $0 dry run: the scripted owner drives the battery through look/find/act
node tools/playtest/eval/soul-eval.mjs run --server-root <checkout serving the client> --repeats 2 --out .local/eval/dry

# a live seat, in a clean environment (#1688's allowlist plus an isolated Claude config), with a paid cap
SEAT_CONFIG_DIR=<isolated config> tools/playtest/eval/live.sh --server-root <checkout> \
  --seat tools/playtest/eval/seats/claude-sonnet.json --max-usd 1.30 --out .local/eval/live

node tools/playtest/eval/soul-eval.mjs report .local/eval/live --against .local/eval/dry
# one arm run as several invocations (one repeat each): join them with commas
node tools/playtest/eval/soul-eval.mjs report .local/eval/new-r1,.local/eval/new-r2 --against .local/eval/old-r1,.local/eval/old-r2
node tools/playtest/eval/soul-eval.mjs load --server-root <checkout> --souls 12,24 --repeats 2 --out .local/eval/load
```

- `--items a,b` runs a subset of the battery.
- `--keep-data` keeps each episode's world database.
- `--catalog <world-catalog.json>` checks and judges against a saved copy of the same template's catalog. Use it for a
  client before 2.25, which keeps no world copy. Each episode records `catalogFrom` (`client` or `reference`).
- `load --first-repeat 2` numbers a load run's repeats from 2, so a stopped load run can be finished cell by cell. Load
  setup paces Souls at 6 per 30 s, under a world's 20 pairings in any 60 s from one address.
- A load report also gives the world's own side from its `live.json`: an act's queue, handler, wait and commit at p50
  and p99 with the acts that waited more than three ticks, and each 10-second tick window ([load.md](../architecture/load.md)).
- `--warm-sec 40` holds each instruction until the Soul is 40 s old, so a run can show the steady state beside the cold start (`sinceCreateMs` is recorded either way).

The battery is checked against each world's own catalog before its episode, so a missing place fails fast.
`run` exits 1, after writing its result, when every episode errored or more than 20% did: a run that measured nothing
never passes.

A live seat needs `--max-usd`. The run stops before an episode once its spend reaches the cap. Measure on a quiet
machine, two repeats per arm, and take the playtest lock where the machine is shared.

## Outputs

`<out>/result.json` (`soul-eval/1`) and `<out>/REPORT.md` are the publishable result. `<out>/episodes/<n>-<item>-r<k>/` holds:

- `episode.json`;
- the observer's `samples.json`;
- `trace/eden-report.jsonl`, the client's own whitelisted request trace: routes, statuses, times and ids, never text,
  tokens or hosts;
- the seat folder.

The seat folder holds the Soul's credentials and the transcript, and it stays local. Check the publishable files before
they leave the machine: `node tools/proof/publication.mjs <file>`. A local URL is never written into `result.json`; the
world appears as `local:<template>`.

## Battery

`tools/playtest/eval/battery/m4-v1.json` holds 11 items:

- #1724's five instructions;
- from the #1097 scorecard: a seat (a bench), a thing activity (music), a plain walk, a place that can't be walked into (the
  West Lake), a ride that isn't offered ("fly"), and a two-step errand;
- #1924: what is on in the next hour, saying it will come to the first thing (another Soul announces it first, `calendar`).

Every item starts where a new Soul arrives. Its check is one of `place`, `placeKind`, `posture`, `receipt`
(`{verb, thingKind?}`), `card` or `calendarInterest` (`"first"`), composed with `all` and `any`
(`tools/playtest/eval/measure.mjs`). No item needs `resolve`.

`tools/playtest/eval/seats/scripted-m4-v1.json` is the scripted owner for the $0 dry run. It proves the measuring, not an
agent.

## Hostile cases

`tools/playtest/eval/battery/hostile-v1.json` is a case battery (#1950): each case puts several scripted Souls on one fresh
local world, each with its own script of `eden.mjs` steps, started together and judged together. Every step is a check
(`ok`, `accepted`, `{refused}`, `{says}`; `until` a receipt ends; a world `restart`), and a case passes only when all hold.
`double-claim`: a second folder's claim is refused `soul.held-elsewhere`, `--move` hands it over once, and the first folder's
next command reports the move. `restart`: the world restarts during two Souls' two-minute acts; within 60 s each receipt
ends and the next act is accepted. `soul-eval.mjs run --battery hostile-v1 --seat scripted --repeats 1` writes each case's
result and the refusal codes seen. A failed case is a finding for a new issue; its bar stays (`episode.mjs`, `runCase`).

Three cases have bystanders (#1974), each played by a driver in `hostile.mjs` (`"drive"`, tuned by `"params"`).
`act-spam`: one Soul sends 200 acts in 10 s through eden.mjs; no answer is a 5xx, at most 60 are not 429, and each of three
bystanders' median act time (its own client trace) stays within 1.5 times its median over the 30 s before. `reconnect-storm`:
twelve Souls reach the world through a relay that cuts every stream at once and turns reconnects away for 6 s; within 10 s
of it reopening every copy (`world-live.json`) is received again and hashes as the world's picture does. `god-wall`: a god
(eden-god.mjs) places a wall across four walking Souls; within 90 s each walk ends (with a reason unless it completed), the
report gives how long each Soul was held, and each next walk is accepted and moves the Soul 1 m within 30 s.

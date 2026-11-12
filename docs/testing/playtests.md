# Playtests

`tools/playtest/` plays a Souls world the way real people do. Coding agents act as the Souls' owners ("seats"), and
model personas decide what each owner says and when. A browser observer records what a visitor would see, and the
review step scores every request against world truth. Use it to measure the Soul experience before and after a
change. It is never part of CI.

The method (what to measure, how to compare arms) is in [playtest method](../process/playtest-method.md). Running a
replay set on a cloud machine is in [cloud playtests](playtests-cloud.md). Live multi-Soul scenes directed from a
chat session are in [swarm director](swarm-director.md).

## Reunion

`tools/playtest/runs/specs/reunion.json` measures what a Soul carries across a restart. Two Souls in Souls homes meet: each
first card names the other, says they both start on the green, and offers two places, `walk:knoll` or `walk:flag-orchard`.
They name the one they choose by its walk id, then a second card sends each to its own place for the evening
(`walk:lab-pond-hall`, `walk:cottage`). A last card with `restart` then restarts each resident client, drops what the last
chat left unread and opens a new chat; they carry on (#1606). `director.worldTime` sets the clock when play starts, not before
onboarding: 15:00 at 120 to 1 puts the end of the first card at 23:00 and of the evening card at 05:00, and the last card at
06:40 the next day, past both midnight and the 06:00 turn of the world day. `tools/playtest/runs/questions/reunion-recall.mjs` scores recall beside M2,
M6 and M7: both Souls finished a walk to the id they each named, using the other's name. `here` shows a near Soul's name to
anyone, so a name alone passes nothing, and a Soul that never parted from the place, or read the plan back from the world,
leaves the run unknown, as does a last move by `run` or `jog`, whose ids aren't walk ids. A first day that didn't happen (no
shared plan, or no walk away) is `unknown` with an uncertainty starting `invalid-day-1:`, so an arm can stop there before
paying for another run. The baseline arm is `reunion-baseline.json`: the same scenario with `briefBytes: 0` on both seats.
`reunion-dry.json` plays both seats with scripted owners and no model, and should pass before any paid arm. Its seats are live: it needs the coordinator's go-ahead and the model budget.

## Commands

```sh
node tools/playtest/playtest.mjs preflight [--server-root <dir>]
node tools/playtest/playtest.mjs run <scenario.json> [--seed n] [--out <dir>] [--from <step>] [--server-root <dir>] [--keep-world] [--world <url>]
node tools/playtest/playtest.mjs review <run-dir> [--from <step>]       # re-run review/develop/report on a run
node tools/playtest/playtest.mjs replay <run-dir> --mode scripted|live [--out <dir>]
node tools/playtest/playtest.mjs compare <runA> <runB>
node tools/playtest/playtest.mjs replay-set [--repeats 2] [--baseline <dir>] [--only <labels>] [--frozen <bundle.json>]
    [--runs-root <dir>] [--out <dir>] [--dry-run] [--score-only] [--force-machine]
node tools/playtest/playtest.mjs freeze-bundle [--runs-root <dir>] [--out <file>] [--baseline <replay-set dir>]
node tools/playtest/playtest.mjs direct <cast.json> ...                 # see swarm-director.md
node tools/playtest/review/rescore-oracles.mjs <run-dir>... | --all <runs-root>   # re-score oracles, no model calls
node tools/playtest/scenarios/lib/validate.mjs [file...]               # check scenarios and casts against their genesis
```

To run a scenario as an owned Soul Run (a versioned spec that references it, refusals before anything starts, a
resource ledger, cleanup on completion, failure and Ctrl-C, retention and a terminal `run-receipt.json`), use
`node tools/playtest/runs/run.mjs validate|start|cleanup`, offline `evaluate|compare` of finished runs, opt-in trace diagnostics (`correlate|inspect`), and recorded cameras with offline `preview|package` (SR5); see [tools/playtest/runs/README.md](../../tools/playtest/runs/README.md).
A run can also choose the world source (genesis or frozen snapshot), apply god-edit setup batches before play, and
compose its cast and scripted direction in the spec; the model-free `scripted-owner` seat adapter plays a Soul through the
world's served `eden.mjs` from a per-seat script, so composed scenes need no live model. `playtest.mjs run` behaves as
before for existing scenarios; a scripted direction entry with `seat: "*"` is now a broadcast.
A frozen snapshot needs no genesis beside it. After boot the runner checks that the world is physically the
snapshot it seeded, ignoring only Soul-body defs that no entity uses, because boot drops those.

Everything prints JSON on stdout and logs to stderr. `--server-root` is the Souls checkout whose server the dev worlds
run from (it needs a built `apps/web/dist`). Pass it explicitly, and pass `--out` or `--runs-root` for where runs go.

## A run

`run` executes eight steps. Each writes `receipts/<n>-<step>.json`. A failed step stops the run and leaves
everything in place, and `--from <step>` resumes.

| Step | Does | Writes |
| --- | --- | --- |
| preflight | server root, web build, CLI, Playwright, model CLIs, machine gate, plan usage | `preflight.json` |
| provision | starts a local dev world from the scenario's genesis (dev auth, fake native minds), with its per-request record on; `--world <url>` uses a world already up elsewhere and skips this | `world.json`, `server/world.log`, `server/requests.jsonl` |
| seats | one folder per seat; the seat agent onboards from the world's served instructions, as a friend's agent would | `seats/<id>/seat.json` |
| play | the director runs personas or a script against the seats; the observer samples world truth and screenshots | `personas/`, `evidence/`, `shots/`, transcripts |
| close | stops seats; collects each seat's session record and prints #1752's measures per instruction; stops the world unless `--keep-world` | `close.json`, `record.json`, `seats/<id>/record/`, `MEASURES.md` |
| review | oracles, reviewer scores, issues, feature requests, emergence | `oracles.jsonl`, `ledger.tsv`, `issues.*`, `feature-requests.*`, `emergence.json` |
| develop | a draft spec per issue and feature request | `specs/<id>.md` |
| report | report, player's-eye journal, metrics, replay record | `REPORT.md`, `journal.md`, `metrics.json`, `replay.json` |

### Seats

A seat is a headless coding agent with its own folder and one session for the whole run. Two adapters exist:
`claude-headless` (`claude -p`, no MCP, a short allowlist of relative-path tools) and `codex-headless`
(`codex exec`). The harness writes only an identity seed and the record switch into the folder before onboarding. It never reads the seat's
credentials afterwards. Seats are told to run one command per tool call, from the seat folder, with relative paths
(`node eden.mjs ...`), and no `cd` or `&&` chains. Between turns a Claude seat keeps `node eden.mjs listen` running,
and when it exits with messages the harness wakes the seat with that output, as Claude Code does for a finished
background task. Codex seats wake only when `wake: true`. An optional god seat sets itself up from the world's
served god skill. Before each turn a Claude seat (god seat included) runs `claude auth status`; on a failure it checks once
more after 5 s, and if that fails too the turn is not run. It is recorded in `turns.jsonl` with `authFailed: true` and
listed in `infrastructure-invalid.jsonl` (check `H-g`), so a signed-out CLI never scores as the agent's failure. Only
the pass or fail and the exit code are kept, never the status output.

A Claude seat starts from a clean environment, not the launcher's (#1687). It gets HOME, PATH, USER, LOGNAME, LANG,
LC_ALL, TERM, SHELL, TMPDIR, CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN, plus the seat's own
settings. Add further names with `PLAYTEST_SEAT_ENV_PASS` (comma- or space-separated). An agent session's own variables
can turn on extra tools: on #1098 they added about 14k tokens to every call. **Seat check:** when a new session's first
call carries more input context than `PLAYTEST_SEAT_CTX_MAX` (default 20000 tokens; 0 turns the check off), that
turn ends at once. The seat then takes no further live turn, and `turns.jsonl` records `seatCheck`. `run-specs.sh` stops
the arm after such a run (exit 8). For #1098's CTRL the first call carried 17.4k.

### The full session record

Every seat runs with the client's full record on (#1773, client 2.29.0 and later): the harness writes an empty
`.eden-record-on` into the seat folder with the identity seed, before the seat's first command (`.souls/` once a seat
has moved into a Souls home). Nothing the agent sees changes. `seat.record: false` turns it off for one seat; a
scenario's `record: false` skips the collecting.

At close, while the world still answers, each seat's record is collected with `tools/soul-trace/collect.mjs` into
`seats/<id>/record/`: the client's record and `serve` log, the seat's raw Claude Code transcript (its reasoning and tool
calls, found under the seat's `CLAUDE_CONFIG_DIR`), the end state of every receipt and owner message, and the versions.
`record.json` in the run folder names, per seat, that bundle, the harness's own turns, transcript and `listen.jsonl`, the
persona's transcript (`personas/<id>/turns.jsonl`, the stand-in owner's messages and reasons), the observer's evidence
packs, and the world's log and per-request record. **The bundles are private**: never attach one, or quotes from it, to
an issue, a pull request or a proof. A proof is an analysing agent's written findings, checked with
`tools/proof/publication.mjs`.

The world's per-request record (`server/requests.jsonl`, `world-request/1`) is written by a dev world started with
`SIM_REQUEST_RECORD=<file>` (`apps/server/src/load/request-record.ts`; off by default, and only on a `DEV_AUTH` world):
one line per `/v1/edge`, `/v1/god` or `/v1/world` request with its arrival, status, world and queue ms (the same numbers
as `Server-Timing`), the client's idempotency key, and the receipt and message ids in the answer. It joins the client's
record by key and ids. A run against `--world <url>` has none; production's is #1750's.

**Measures.** The run prints, and writes to `MEASURES.md`, #1752's per-instruction measures and report
(`tools/playtest/eval/measure.mjs`, `report.mjs`): success, model turns and API calls, world calls by route, first
motion, client and server ms per call, refusals by code, tokens and cost. They are read from the collected record, so
there is one recorder. An instruction runs from one owner message to the next. A message is judged when its words are
an item of the scenario's `battery` (its `file`, or inline `items`), with that item's check against the observer's last
sample in the window; other messages are listed but not judged. `firstMotion` is at the observer's `sampleSec`. Beside
them, "Run facts" lists the agent's local lookups (`find`, `query`) that found nothing and how long each stretch of them
took, and the world's own times from its per-request record.

`scenarios/session-1724-owner.json` is the shown run: #1724's five instructions, sent word for word by the
`owner-1724` persona, on a fresh Eden 2026 world, one Sonnet seat, passive observer, deterministic review.

### Personas

`personas/*.md` are character sheets: newcomer, casual, social, spectator, storyteller, boundary, pinkteam, expert,
and the creators first-timer, tinkerer, storyteller-god and pinkteam-god. `owner-1724` is an owner with five fixed errands, sent word for word so a run can judge them. A sheet describes who the player is, their
patience, attention and channel mix, how they rate, and the JSON they answer with. It never mentions Souls internals.
A persona keeps one model session per run and sees only what a player sees: a screenshot, the legible page text, the
chat as a terminal renders it, and the card. It answers with what to say (chat or card), how long to wait, a rating,
desires and complaints. Seats are scheduled from separate seeded RNGs, and no persona sees another seat's information.

### Observer and evidence

The observer polls the public and owner routes for each Soul (place, posture, activity, receipts) and keeps follow
and wide browser cameras open. Each request gets `evidence/<requestId>.json`: what was sent, the ack and result,
body samples, receipts, screenshots, linked chat turns and server errors, up to its budget cutoff. Facts observed
after the cutoff are diagnostic only.

### Review

- **Oracles** (`review/oracles.mjs`) are code-only checks that return pass, fail or unknown: ack latency, result sent,
  listening, arrival, posture, duration held, inside-solid, no-progress, oscillation, stuck receipt, truthfulness,
  vocabulary, duplicate acts, server errors and first body change. On the current client (look and find locally, then
  `act <id>`), an unknown wording is an act refused `act.not-an-id` (or `capability.unknown`); it passes when the
  refusal offers an alternative or a `find`/`query` in the window found rows. A refused act sent again is a retry, not a
  duplicate, and a `plan` counts as acts. A card request's acts are those of the turns that started in its window. A scripted request may carry an `expect` block (a
  target from the genesis, words the answer must use, a facing) scored by `review/expect-oracles.mjs`.
- **Reviewer** (`review/reviewer.mjs`) scores each request H (hit), P (partial), M (honest miss) or W (wrong) using
  [`review/RUBRIC.md`](../../tools/playtest/review/RUBRIC.md). It writes issues in player terms only; causes, code
  areas and fixes are stripped. With `review.mode: "deterministic"` no model scores are made and only oracles count.
- **Scenario-truth answers.** The `expect` oracles read only answers written by the cutoff; an answer that came only
  after it is a fail. A direction is read from the sentences that name the target, plus an "It…" sentence right after
  one (the whole answer when none does), and "can't tell" there is a fail. A description counts only after a `view` that started by the answer, and a
  refused act to turn or face is a fail. The rubric never scores a claim that was true when written as W.
  A `near` expect names the place asked about in `targets[]` (template position and the radius the author used), and
  an answer word counts only when the genesis places a thing by that word within that radius of the place, not merely
  near where the Soul stood. A word that names nothing placed (an alias such as "hill") still counts. The scenario
  validator holds every `answer.anyOf` word to the same truth. Older run folders without `targets[]` score as before.
- **Developer** (`review/developer.mjs`) reads the server source (read-only tools) and writes a spec per issue marked
  `DRAFT — NOT IMPLEMENTED`. It never edits files.

## Scenarios

`scenarios/*.json` (validated by `scenarios/lib/validate.mjs`):

```json
{
  "name": "newcomer-rich-1", "version": 1, "seed": 1,
  "world": { "kind": "dev", "genesis": "worlds/templates/eden-2026.json", "slug": "pt-eden-a", "port": 4990 },
  "durationSec": 600,
  "seats": [{ "id": "pip", "adapter": "claude-headless", "model": "haiku", "effort": "medium",
              "persona": "newcomer", "personaModel": "opus", "startOffsetSec": 0, "soulName": "Pip",
              "channelMix": { "chat": 0.3, "card": 0.7 } }],
  "god": null,
  "director": { "mode": "persona", "requestsTarget": 8, "glanceSec": [10, 30] },
  "observer": { "sampleSec": 5, "cameras": ["follow", "wide"], "viewport": [1280, 800], "dpr": 1 },
  "review": { "reviewerModel": "opus", "developerModel": "opus", "rubric": "accept3" },
  "rails": { "maxTurnsPerRequest": 6, "maxTurnWallSec": 240, "quotaStopPct": 90 }
}
```

- `world.kind` must be `dev`. Every seat needs an `id`, an `adapter`, a `soulName` and (for Claude) a `model`.
- A seat may set `briefBytes` (a whole number, `0` for none): the harness writes it into the seat's Souls home
  `config.json` once the mind has made the home, and again before each turn and restart, so an arm can run without the
  pre-turn brief. Reunion's baseline arm (`reunion-baseline.json`) uses `0`; `seat.json` records it.
- `director.mode` is `persona` (every seat needs a persona) or `scripted`, with
  `script: [{ "seat", "atSec", "channel": "chat"|"card", "text", "budgetSec", "expect"? }]`. A seat's scripted
  requests must not overlap their budgets.
- **Batteries** are scripted scenarios that send the same basic requests to every seat and are scored by oracles
  (`basics-walk-act-*.json`). `scenarios/unified/` holds frozen journey fixtures with exact physical targets; see its
  README.

## Frozen sets and scorecards

`review/scorecard.mjs` names a frozen set of runs (batteries and persona runs). `replay-set` replays each one as a
scripted replay that sends the original requests on the original channels, `--repeats` times (default two), one after
another. It writes `SCORECARD.md` and `replay-set.json`. The scorecard reports the measures with their thresholds
against a baseline, plus a no-new-bugs verdict. W counts and physical-oracle failures must not rise on any frozen run,
and H must not fall on any battery seat. A change counts only if every repeat shows it, and repeats that disagree are
reported as unsure. `--score-only` rescores existing repeats, and `--dry-run` prints the plan.

`freeze-bundle` writes `frozen/frozen.json`: each frozen run's replay scenario and baseline measures, without
screenshots or transcripts. Machines without the original run folders can then run the set.

## Measuring well

- **Use a quiet machine.** The machine gate requires a 1-minute load under 10 and at least 6 GB of reclaimable memory.
  A loaded machine produces slow client calls and false failures. `replay-set` waits for the gate (`--gate-wait-min`,
  default 30) and stops if it never clears. `--force-machine` continues and records the breach.
- **Two repeats per arm.** Compare arms only on like-for-like repeats (scripted replay against scripted replay),
  and fix acceptance bars and budgets before the baseline is measured.
- Preflight checks Claude plan usage through the script named by `PLAYTEST_USAGE_PY`. If that script is absent the
  check is skipped.

## Timed runs

Timed runs without a model (the walk gate, the scripted Soul eval, the eval's load mode, the capacity bench's client
load, the meetup workload, the slopes tick profile) go to the `souls-timed` self-hosted runners through the manual
`timed-run` workflow (`.github/workflows/timed-run.yml`): `ref`, `command` (`walk`, `eval-scripted`, `eval-load`,
`bench-client`, `meetup` or `slopes-profile`), `repeats` (1 to 3) and allowlisted `args`. Each runner has cores of its
own and takes one job; a run records its starting load and does not start while its own cores are busy. The last four
put the world on two of the runner's four physical cores and the load generator on the other two, recorded in
`timed-run.json`. The runners use a dedicated, unprivileged account: the
args allowlist is not a security boundary, since a branch's own scripts run. Live-model seats and GPU work stay on a
workstation.

## Request ceilings on local test worlds

Callers launch test worlds exactly as `arena/provision.mjs` `startWorld` does: `node apps/server/src/main.ts` directly
on `127.0.0.1:<port>` with the release defaults. Set no load variables (`SIM_ADMISSION`, `SIM_FLOOD`, `SIM_LOAD_*`,
`SIM_WAKING_LIMIT`). The world then admits like production, so a test world measures what the live one does
([load contract](../architecture/load.md) §2b). What applies there:

- **No per-address limit.** The world's flood guard (`apps/server/src/flood.ts`) and the launcher's address ceilings
  (`tools/world-launcher/flood.mjs` `SOUL_CEILINGS.ipPer10s/ipConcurrent/ipListen`) both key on `x-forwarded-for`, which
  only the reverse proxy sets. A caller on 127.0.0.1 is never limited by address.
- **No listener caps.** `soulListen` / `accountListen` / `ipListen` are launcher ceilings. A world started directly has
  none. Long-polls and streams (`/v1/edge/wait`, `/v1/edge/inbox/listen`, `/v1/edge/events`) are C0 in the world and are
  never queued or refused.
- **In-world admission stays on.** It allows one heavy (C1/C2) request in flight per Soul token. A second one at once
  gets `429 soul.busy` with Retry-After 1. Twenty such overlaps in a minute, or the CPU budget overrun three times, give
  that Soul 60 s of `soul.slow-down`, its acts included. A driver must therefore keep one heavy request in flight per
  Soul. Harness observation goes through the owner and public routes (`arena/owner.mjs`), which the admission does not
  count.
- Measured (release 402) on a copy of the Eden 2026 world with 6 Souls: each Soul held an SSE events stream, a wait
  long-poll and an inbox listen (18 held in all) and ran sequential here/observe/capabilities reads, about 1.5 a second
  per Soul, for 60 s, alongside the public Soul reads. All 538 heavy reads and all held requests were answered 200. Two
  concurrent `here` reads per Soul gave 5 `soul.busy` out of 12.
- **Only when a test world runs behind the launcher**, with Souls that share one owner account, raise that world's
  account ceilings, never the address ones: the registry `limits` in worlds.json, or
  `op.mjs set-limits --port <launcher port> --slug <slug> --limits '{"accountListen":24,"accountHeavyPerMin":600,"worldBudgetRps":30}'`.
  At 3 held per Soul plus a thin `listen`, five Souls on one account pass `accountListen` 12. The default 120 heavy a
  minute per account is about 24 per Soul.
- A `429 client.rate` / `soul.busy` / `account.rate` from our own driver means a ceiling is working, not a server bug.
  Fix the driver.

## Tests

Each module has `node --test` files on recorded fixtures (no world, no model):

```sh
node --test tools/playtest/**/*.test.mjs
```

`arena/smoke.mjs` and `observer/smoke.mjs` boot a real dev world and are run by hand.

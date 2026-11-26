# The driver

Engine v2 I10 (#2693): one program that drives 1,000 scripted agents through `gatewayd` from the shared load shapes
(`tools/bench/capacity/profiles/shapes.mjs`, #2556), open loop, without being the bottleneck. Every later load gate
uses it (I11, V16, O5, O6, G8, R11's crowd). The agents are scripted: no model is called.

```sh
cd v2
cargo build --release -p gatewayd -p worldd -p driver
node tools/driver/loads.mjs target --seed 1 --out <run folder>/schedule.txt
target/release/driver --schedule <run folder>/schedule.txt --dir <run folder> [--think-ms 0] [--late-ms 50]
```

- **`loads.mjs`** imports the shared shapes (never copies them) and writes a schedule: its `describe` line, then
  `<due ms> <agent> <kind> <verb>` a line. The loads, each 600 s by default (`--agents`, `--seconds`, `--seed`):
  - `target`: 1,000 agents on a copy of `event` named `target` with `presence` 1, `place.gatheredShare` 1 and
    `rate.medianSec` 18: about 50,400 to 50,900 acts (seeds 1 to 3), a little over 5,000 a minute.
  - `target-even`: `schedule('uniform', 1000, 600, seed, {actSec: 12})`, about 50,000 acts.
  - `stretch`: two schedules merged, 900 agents on the `target` copy and 100 on `uniform` at `actSec` 0.5 (2 intents
    a second, which `event` cannot say): about 166,000 acts.
  - `ladder-<n>-uneven` and `ladder-<n>-even` for n of 10, 50, 100, 200, 350 and 500 (X7, #4015; `--agents` is not
    read): uneven is the shared `event` shape as it is; even is `uniform` at the pace that intends as many acts as
    the uneven arm with the same seconds and seed, so the two arms differ in how the load falls, not in how much.
  - `VERBS` maps each shape kind to its v2 intent's verb; a kind with none is written as `-`, never sent, and counted
    under `unmapped`.
  The shape's name and the seed together fix the numbers: the same name and seed give the same schedule.
- **`driver`** (Rust, one thread) starts `worldd gateway-link` and `gatewayd` from its own folder, signs every agent
  in, then hands each act to its agent's socket at its due time (plus `--think-ms`, a fixed per-agent share of it),
  never waiting for an answer first. It prints the describe line and the report, also written to `report.json`:
  intended against achieved ("under-driven" below 95 %), the share sent within `--late-ms` of the due time and the
  lateness quantiles, `driverCores` (its own user and system time over the run), the answers, `byVerb`,
  `unmapped`, `byTenth` (the same per tenth of the agents by intended acts, busiest first) and `perMinute`: per
  minute of the run, receipts (an act's end, kind 1) and receipts a second, act latency from send to
  the act's first answer (accepted, receipt or refusal) at p50, p95 and p99, refusals by name, and errors by name
  (`unanswered`, below; `socket-closed`, `send-failed`, a gateway's own word such as `token.refused`). An act
  answered accepted (kind 3: a walk or a form whose run started, W11 #4087) is timed then and kept until its receipt
  or refusal; a sit's acceptance does not seat the Soul, its receipt does. One accepted and not ended when the drain
  runs out is counted in `unfinished`, not as an error. A `claim-taken` (or a form's run `left`) on an act the same
  agent's later act already replaced is the open loop's own doing, not the world refusing a Soul: it is counted as
  `replacedByOwnAct`, not as a refusal, and `--trace` writes it as `<name> replaced-by <sequence>` (#4171).

## A served world (X7, #4015)

With `--remote` and `--tokens` the driver starts no world and no gateway: it signs in pre-paired Souls at a gateway
that serves a world and sends the schedule as them. Load runs use marked test Souls only: pair them with
`node tools/ops/test-soul pair <world> <n> --directory <origin> --out <file>` (#4016), whose file (one
`<soul grant> <token>` a line, mode 0600, kept outside the repository) is `--tokens`; a file of bare tokens, as
`worldd seed` writes `souls.tokens`, is read too. Agent k signs in with line k; the file needs at least as many
Souls as the schedule has agents.

The release owner's command, from a checkout on a machine that reaches the world's gatewayd port (the loopback port
on the world's host; `GATEWAYD_ARGS` in its unit names the port). Pair the test Souls first (#4016), then run each arm:

```sh
cd v2
cargo build --release -p driver
node tools/ops/test-soul pair <world> 100 --directory <origin> --out <private folder>/souls.tokens
for arm in uneven even; do
  node tools/driver/loads.mjs ladder-100-$arm --seconds 600 --seed 1 --out <run folder>/$arm/schedule.txt
  target/release/driver --schedule <run folder>/$arm/schedule.txt --dir <run folder>/$arm \
    --remote ws://<gatewayd host>:<port> --tokens <private folder>/souls.tokens
done
```

`--remote` takes `ws://<host>:<port>` (the agents' path `/v2/ws` added) or a full `ws://` URL. The driver carries no
TLS, so it runs where it reaches gatewayd's own port, not through the public proxy. Each Soul's sequences start at the
run's start in Unix milliseconds, past any an earlier run sent; every intent goes against the zero basis.

**Targets** (`src/targets.rs`). Once every agent is signed in, and before the clock starts, each agent sends one
`<ns>:rise` (its Soul's first intent, which has the world bear its body, C3; answered, mostly `not-seated`, outside
the report), and the driver reads the world's ids the way a client does: the first agent syncs its copy over its own socket (R5b's compare and descend:
its scope's hashes, then every record they reach, each checked against its hash), and the driver fetches the world's
kind entries (`GET /v2/entries`, which gatewayd serves with `--entries`, as every placed world's unit does). The line
`targets:` and the report's `targets` say what it found. Targets are reachable (#4193): only things standing on the
ground most bodies stand on (the same frame), not things inside a building or on a table. A body form's thing is never
the world's land (an entry `"owner": "place"`: a mountain range, the sea), whose origin is the world's own wherever
its outline lies, so it was "nearest" every Soul born at the middle (#4171). Each Soul gets its own
four nearest walk, sit, take and thing targets, nearest its body (positions in micrometres, each frame's turn
applied), taking a farther one where three Souls already have one; the report's `sameTarget` says how many Souls were
sent to one place over the run (the most, and the places sent more than three). Then each act of the schedule goes as:

- **walk**: `<ns>:walk` to one of the Soul's own targets with a seat (its stand point), in turn by act;
- **sit**: `<ns>:sit` on one of the Soul's own targets with a seat of posture `sit`; once a sit's receipt has come, the Soul's next walk or sit goes as `<ns>:rise`, as an agent would
  (a walk while seated is refused, `resource-held`), while a sit still on its way is replaced by the next walk;
- **gesture, sit-ground, read, eat, play-music**: the first form of `FORMS` an entry offers (`wave`; `sit_down`;
  `read`; `eat`, `bite` or `drink`; `play_music` or `play`), on the things of that kind, or on the Soul's own body
  (its `souls:body-of` link in the copy) when the body's kind has an entry with the form. A form that needs the thing held first (a
  book's `read`, an apple's `bite`) is left out. A kind with no such form, or a Soul whose body is not in the first
  agent's copy, sends a walk instead, counted under `standIns`;
- **say**: withheld, counted under `withheld`, so a run on a world people visit says nothing out loud. `--speech`
  sends them with the words `(load test)`; CI's local run uses it.

The report adds `refusedBy`, the refusals by `<verb> <name>`. Each agent waits 15 s after its last act for its
answers (a form's receipt comes when it ends); one never answered by then is `unanswered`, and one answered accepted
that has not ended is counted in `unfinished`.

**Rehearsing locally.** `node tools/driver/slice.mjs --facts <testworld facts> --out <folder>` puts an Eden slice on
N2's test world (20 benches, 15 chairs, 3 speakers, 2 books, 2 apples, with Eden's own entries; its bodies
have no entry, so gestures and sit-ground stand in as walks). Seed it and serve it behind a gatewayd with its entries, then run the driver as above:

```sh
cd v2
cargo build --release -p gatewayd -p worldd -p testworld -p driver
target/release/testworld --seed 1 --things 0 --out <folder>
node tools/driver/slice.mjs --facts <folder>/testworld-s1-t0.facts.json --out <folder>
target/release/worldd seed --facts <folder>/slice.facts.json --dir <folder>/w --souls 50 --at 0,0 --entries <folder>/entries
target/release/worldd serve --dir <folder>/w --socket <folder>/w.sock &
target/release/gatewayd --listen 127.0.0.1:0 --world <folder>/w.sock --tokens <folder>/w/tokens --build 1220 \
  --entries <folder>/w/entries &       # prints `listening <address>`
node tools/driver/loads.mjs ladder-50-uneven --seconds 120 --seed 1 --out <folder>/schedule.txt
target/release/driver --schedule <folder>/schedule.txt --dir <folder>/run --tokens <folder>/w/souls.tokens \
  --remote ws://<address>
```

CI's `driver-served` step (`v2/tools/ci.sh`, client leg) runs a 60 s `ladder-10-uneven` with `--speech` against N2's
test world (no entries: walks go to any node of the copy, and the other kinds stand in as walks) under `worldd serve`
and its own gatewayd.

## What a viewer sees, stuck Souls and the real mix (stage 2a, #4154)

- **`--stream <http://host:port/path/>`**: the world's public stream as the viewers' origin serves it (the folder
  `views/world.json`'s `stream` names). A thread of its own reads it as the page's worker does: the pointer every
  250 ms, then each new part in order, over HTTP; parts written before the run are not read. Each receipt or
  acceptance names its intent's id (field 4), and each effect in a part names the intent that caused it, so the
  report's `visible` is every act the world took joined with the first part that shows something it caused: `seen`
  of `taken`, send to accepted (the world's first answer taking the act) p50/p95/p99 over the same acts, act wait from
  the send to the first visible move p50/p95/p99 (ms), `within100Ms` and `within300Ms`, the same per verb, the
  stream's lag at the reader (each part's arrival against the wall time its world-time end fell at) and the writer's
  own lag (the newest part's end against the wall when the pointer is read). The stream cuts a part
  every 0.5 s of world time and writes it 0.25 s after (`worldd::view_out`, rules 3 and 11), so a viewer's wait has
  that floor whatever the load.
- **`stuck`** in the report, per agent from its own socket: `stuck` counts agents that had an act unanswered for 60 s
  or more with no answer of any kind meanwhile (and `accuracy`: 15 s after the last act the first agent reads its copy
  again and each agent's last act naming a place is checked by where its body is: within 4 m of the place, positions
  in micrometres composed with each frame's turn, or seated in it (#4193; #4154 read micrometres as millimetres)); `refusedOnly` those that acted for 60 s or more with nothing but
  refusals back; `stallMaxMs` and the last answer's age at the end of the schedule.
- **The mix** (`loads.mjs`, `mix-<n>-<even|uneven>-<every4|burst|gene17|gene42>`, n of the ladder's counts, 20 for the
  position check's rung, or `5000x500`): every act's kind is
  drawn from `MIX` (say 22 %, walk 14, gesture 10, take 10, go_to 8, sit 8, look_at 7, point 6, touch 6, lean_on 5,
  wait_by 4). `every4` is each agent every 4 s (125 acts a second at 500), `burst` every 1.5 s, and Gene's 2 to 5 acts a
  minute a Soul `gene17` (every 29.4 s, 17 a second at 500) and `gene42` (every 12 s, 42 a second); even is `uniform`,
  uneven the `event` shape with every agent present, its time scaled to intend as many acts. The driver sends a
  gesture as the body family's argument-free forms in turn (wave, clap, cheer, bow, shrug, stretch, jump, dance,
  look_around), the one-thing forms on the Soul's body with a thing of the copy as their argument (C2's
  `[[name, id]]`), and take as the thing's own `take`, the next one putting it down (`hands:set-down`) once the take's
  receipt has come. A seeded world's bodies are `souls:body`, which names no entry: their forms are the family
  entry's (`"owner": "family"`).

`v2/tools/bench/stage2a/` runs it on Eden: `rung.sh` one rung (world processes on a CPU set, the driver apart),
`ladder.sh` the counts, rates, arms and repeats, `analyze.mjs` the summary and tables against the bar, `camera.sh`
the whole local stack at a load for filming, and `box.sh` all of it on a fresh Linux box in one command (its head says
what the box needs; Eden's facts file is copied to it).

## Faults (X10, #4019)

Flags for a fault pass on a served world (`v2/tools/stall-test/x10-faults.sh` runs the whole pass and prints its
table, `x10-check` reads each arm):

- `--reconnect`: an agent whose socket is lost comes back as the runbook's client does (a wait inside 2 s, then a try
  every 50 to 250 ms for up to 120 s), and sends again, under its old sequence, every intent it has no answer for. A
  `world.restarting` answer is sent again 200 ms later.
- `--drop <share>@<second>+<seconds away>`: that share of the agents there at that second of the clock (an act due
  before it), spread across them, close their sockets then and come back after the seconds away; acts due meanwhile
  go when they are back.
- `--viewers <n>@<slow share> --view-key <file> [--slow-read-ms 2000]`: n view sockets, signed in with view tokens
  minted with the gateway's `--view-key`, each following one Soul's body at the full level; the slow share waits
  `--slow-read-ms` after each frame it reads. The report's `viewers` gives each one's items, longest gap and how often
  it was let go.
- `--trace <file>`: one line per Soul (`soul <agent> <scope hex>:<counter>`), per receipt (`ack` or, a second one for
  the same sequence, `dup`), per first answer (`first <agent> <sequence> <sent ms> <answered ms> <receipt or refusal>`),
  per lost and regained socket (`gone`, `back`) and per act never answered (`open`), times in Unix ms. #4171 adds, to
  read each refusal against the acts before it: per act sent (`sent <agent> <sequence> <ms> <verb> <place or ->`, the
  place a walk's or a sit's target or a body form's thing), per accepted act a refusal ends (`end <agent> <sequence>
  <ms> <name>`), and per refusal with words (`why <agent> <sequence> <its detail>`, field 8: who holds what).

The report adds `duplicateReceipts`, `resent` and `restartingAnswers`.

Limits: every agent signs in before the clock starts, so a late arrival is a socket that is idle until its first
act. Targets are read once, from the first agent's scope (the room its body is in), so on a world whose test Souls
stand in different rooms the others walk to that room's things, and a Soul whose body is elsewhere stands in a walk
for its body's forms. On macOS nothing pins the driver apart from the world's processes; on a shared machine its
lateness includes the machine's load.

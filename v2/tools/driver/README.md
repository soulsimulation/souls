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
  minute of the run, receipts (a receipt, or a move's acceptance) and receipts a second, act latency from send to
  the act's first answer (receipt or refusal) at p50, p95 and p99, refusals by name, and errors by name
  (`unanswered` 5 s after the last send, `socket-closed`, `send-failed`, a gateway's own word such as
  `token.refused`).

## A served world (X7, #4015)

With `--remote` and `--tokens` the driver starts no world and no gateway: it signs in pre-paired Souls at a gateway
that serves a world and sends the schedule as them. Load runs use marked test Souls only: pair them with
`node tools/ops/test-soul pair <world> <n> --directory <origin> --out <file>` (#4016), whose file (one
`<soul grant> <token>` a line, mode 0600, kept outside the repository) is `--tokens`; a file of bare tokens, as
`worldd seed` writes `souls.tokens`, is read too. Agent k signs in with line k; the file needs at least as many
Souls as the schedule has agents.

```sh
cd v2
cargo build --release -p driver
node tools/driver/loads.mjs ladder-100-uneven --seconds 600 --seed 1 --out <run folder>/schedule.txt
target/release/driver --schedule <run folder>/schedule.txt --dir <run folder> \
  --remote ws://<gatewayd host>:<port> --tokens <test Souls' file>
```

`--remote` takes `ws://<host>:<port>` (the agents' path `/v2/ws` added) or a full `ws://` URL. The driver carries no
TLS, so it runs where it reaches gatewayd's own port, not through the public proxy. Each act goes with no target and
no parameter, against the zero basis, except a say, which carries the words `(load test)`; a served world refuses the
others by name (`move.no-target`, `intent.not-a-form-on-a-node`), counted under `refusals`. Each Soul's sequences
start at the run's start in Unix milliseconds, past any an earlier run sent. CI's `driver-served` step (`v2/tools/ci.sh`,
client leg) runs a 60 s `ladder-10-uneven` this way against N2's test world under `worldd serve` and its own gatewayd.

Limits: every agent signs in before the clock starts, so a late arrival is a socket that is idle until its first
act. Walks and forms carry no target yet, so on a served world only the says land; the rest measure the refusal
path. On macOS nothing pins the driver apart from the world's processes; on a shared machine its lateness includes
the machine's load.

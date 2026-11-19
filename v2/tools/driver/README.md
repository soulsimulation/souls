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
  - `VERBS` maps each shape kind to its v2 intent's verb; a kind with none is written as `-`, never sent, and counted
    under `unmapped`.
  The shape's name and the seed together fix the numbers: the same name and seed give the same schedule.
- **`driver`** (Rust, one thread) starts `worldd gateway-link` and `gatewayd` from its own folder, signs every agent
  in, then hands each act to its agent's socket at its due time (plus `--think-ms`, a fixed per-agent share of it),
  never waiting for an answer first. It prints the describe line and the report, also written to `report.json`:
  intended against achieved ("under-driven" below 95 %), the share sent within `--late-ms` of the due time and the
  lateness quantiles, `driverCores` (its own user and system time over the run), the answers, `byVerb`,
  `unmapped`, and `byTenth` (the same per tenth of the agents by intended acts, busiest first).

Limits: every agent signs in before the clock starts, so a late arrival is a socket that is idle until its first
act. On macOS nothing pins the driver apart from the world's processes; on a shared machine its lateness includes
the machine's load.

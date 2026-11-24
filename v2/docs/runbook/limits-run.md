# The limits run

0.133 P3. One command measures the fixed limits on the production machine: a throwaway Eden on the new engine with N
agents and M viewers, N stepped up the ladder (100, 250, 500, 750, 1,000) in even and uneven load, two repeats, every
moved world running (or asleep) beside it. It prints one table and the limit that gave way first. Run it once, after
W4 (every world moved), S3, N1 and N2 are released. It is the release owner's, like a drill: never on a schedule.

## What it touches

Nothing that serves. Each rung (`v2/tools/bench/stage2a/rung.sh`) seeds its own Eden from Eden's facts
(`worldd seed`) into its own folder under the checkout's `.local/`, and runs `worldd serve`, a `gatewayd` and a
viewers' origin on loopback ports the kernel picks. No unit, no directory entry, no proxy route: no visitor or
agent can reach it. The agents are the driver's scripted mix (fake minds, no model). The viewers are the viewers
bench's readers (`tools/bench/capacity/viewers/v2-readers.mjs`) on that origin. A rung stops its own processes by pid
when it ends or is stopped, and removes its world's folder. The scripts refuse a folder under `/var/lib/souls` or
`/etc/souls`. Run them as an ordinary user (not root, not `souls`), so they cannot write a served world's files.

## Before: the kit, on the build machine

From a checkout of the commit production runs, on Linux x86-64 with rustup and Node 22.18 or later:

```sh
pnpm install --frozen-lockfile
node v2/tools/import-eden/export/export.ts --out .local/eden.facts.json
bash v2/tools/bench/stage2a/kit.sh .local/eden.facts.json .local/limits-kit.tar.gz
```

The kit (`kit.sh`) is the release `worldd`, `gatewayd` and `driver`, replica's wasm-bindgen package and the facts. Copy
`.local/limits-kit.tar.gz` to the production machine as you copy a release bundle ([install.md](install.md)).

## The run, on the production machine

In a checkout of the same commit (`node -v` 22.18 or later; no Rust toolchain needed):

```sh
tar -xzf .local/limits-kit.tar.gz
DRIVER_CPUS=7 VIEWERS=500 bash v2/tools/bench/stage2a/limits.sh
```

- **Load.** `SECS` (default 600, the 10 minutes P3 asks) a rung, `REPEATS` 2, `ARMS` `even uneven`, `RATE` the
  mix's rate (`every4`: each agent every 4 s; `burst`; `gene17`: about 17 acts a second at 500 agents). Gene's M is
  the ladder's counts (the first argument, default `"100 250 500 750 1000"`), his N the rate, his Q `VIEWERS`.
- **Placement.** The throwaway world's processes run on every core beside the moved worlds (`WORLD_CPUS` unset).
  The driver and the readers run on `DRIVER_CPUS` (and `VIEWER_CPUS`, default the same); on the 8-core production
  machine, core 7. The table gives the readers' own cores: past one core they, not the world, are the limit, and
  `VIEWERS` comes down.
- **Stop rule.** The ladder stops after the first count on which a limit gave way, and names it. `STOP=0` runs every
  count. Ctrl-C (or `kill` of the `limits.sh` pid) stops the rung and its processes.
- **Output.** Each rung's line as it ends, then `table.md` and `run.txt` in the run's folder
  (`.local/limits-<UTC time>/`, printed on the last line). Paste the table into [capacity](../../../docs/architecture/capacity.md).

## The limits it judges

Fixed before any run (`limits.mjs`), from the master view's limits:

| Limit | Bar | Read from |
|---|---|---|
| Receipt | send to accepted or refused, p50 ≤ 100 ms, p95 ≤ 300 ms | the driver |
| Viewer delay | a part's arrival at a viewer after its end in world time, p50 ≤ 1 s, p95 ≤ 2 s, and not growing (last minute's p50 at most 1.5 times the first's, and at most 250 ms more) | the readers; the driver's stream reader when `VIEWERS=0` |
| Ticks on time | ≥ 99 in 100 over the load window | the world's health |
| Stuck Souls | 0 (the driver's rule, `stuck.rule` in its report) | the driver |
| No result | a rung that gives none: a world, gateway or driver ended | the rung's folder |
| Memory | world, gateway and origin together ≤ `MEM_LIMIT_MB`, when set | the sampler |

Reported beside them, not judged: refusals by cause, processor cores and the busiest world thread, send to the first
visible move, the viewers' first picture and drops. **Not measured by this run:** join time and frame rate (read
from the old page in a real browser, P3's own step); read time, start time and action time. The readers' viewer
delay ends when a part is in the viewer's hands: the page then plays it 2 s behind the world by design
(`BEHIND_US`, `apps/web/src/v2-engine/source/clock.ts`), which the browser step sees.

## How long it takes

A rung takes its load (`SECS`) plus about 65 s: seeding and starting the world (about 17 s), signing the agents in,
the driver's 15 s drain and the teardown. The dry run on the build machine (24 Nov 2026: 100 and 500 agents, even
and uneven, two repeats, 120 s a rung, 500 viewers) took 24 minutes for 8 rungs, 181 to 186 s each. The production
run is 5 counts, 2 arms and 2 repeats of 600 s: 20 rungs of about 665 s, **about 3 h 45 min** when every limit holds
(the 750 and 1,000 rungs' extra seeding and sign-in are not yet measured). It is shorter when the ladder stops:
about 2 h 15 min when 500 is the first count to give way.

## Drill

The dry run, on the build machine from the unpacked kit: the world on 8 threads (the production machine's size),
the driver and the readers on 4 others, quiet cores chosen at the time:

```sh
SECS=120 STOP=0 WORLD_CPUS=12-15,36-39 DRIVER_CPUS=16-17,40-41 bash v2/tools/bench/stage2a/limits.sh "100 500"
```

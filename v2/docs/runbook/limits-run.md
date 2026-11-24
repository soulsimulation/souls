# The limits run

0.133 P3. One command measures the fixed limits on the production Eden with every moved world beside it: M marked
test Souls sending the Soul Actions mix at N intents a second, Q viewers reading Eden's stream through the front
door, 10 minutes a rung, even and uneven load, two repeats. It prints one table and the limit that gave way first.
The load runs on the shared build machine, never on the release owner's laptop. A guard refuses to start a rung
unless Eden is healthy with memory to spare, and stops the load the moment Eden's ticks or memory pass their bars.
It is the release owner's, like a drill: never on a schedule.

## M, N and Q

From 0.133's "Needs Gene" 3: 0.132's published capacity run ([capacity](../../../docs/architecture/capacity.md),
"0.132, 23 Nov 2026"). The largest M at which every limit held is **500** agents, the top of that ladder. N is that
rung's rate, **`every4`: about 125 intents a second**. (At 500 in bursts, 330 a second, the clock gave way.) Q is
**100** viewers on Eden, the floor the recommendation names. These are the served run's defaults: count `500`,
`RATE=every4`, `VIEWERS=100`. The later 0.133 bench run held at 750 `every4`. A second run at `750` is the
command with `750` as its argument, once the first table is in.

## The topology it runs on (24 Nov 2026)

- **The production machine** serves all 11 moved worlds. Each world is `worldd@<instance>.service` in
  `souls.slice`. The slice's `MemoryMax` is 14G. Eden's own `MemoryMax` is 4G and its `MemoryLow` 2G
  (`v2/tools/ops/units/world-limits.json`). Every other world keeps the unit's 2G
  ([world restarting](world-restarting.md)). Eden's gatewayd listens on loopback 7330, the viewers' origin on 7320.
  The front door sends `/s/*` to the origin with `/s` stripped, and `/w/eden/v2/*` to Eden's gatewayd
  (`v2/tools/ops/proxy/soul-game-moved.caddy`).
- **The agents** are marked test Souls ([operator test Souls](test-souls.md), "Many test Souls for a load run"),
  paired on the directory machine and retired after the run. Fake minds: the driver's scripted mix, no model.
- **The load machine** is the shared build machine, on the cores of a timed runner that is idle at the time. The
  driver (one thread) and the viewers' readers run there. The driver carries no TLS, so it reaches Eden's gatewayd
  and the origin through an SSH forward to the production machine's loopback ports. The viewers read through the
  front door over https, as a visitor does. The preflight prints the TCP connect time to the gateway: every receipt
  includes that time, and the table is read with it.
- **The guard** (`v2/tools/bench/stage2a/guard.mjs probe`) runs on the production machine. It reads files only:
  Eden's `health.json` and supervisor record, every world's state, and the cgroup's `memory.current` and
  `memory.max` for Eden and `souls.slice`. It prints one JSON line every 5 s over the same SSH connection, and the
  load machine reads them (`PROBE`).

## The guard's bars

Fixed before the run (`guard.mjs` `BARS`):

| When | Check | Bar |
|---|---|---|
| Before each rung (preflight; refused = exit 2, the run stops) | Eden's supervisor state | `running` |
| | Eden's `health.json` | written within 30 s |
| | Eden's ticks on time, over two samples 10 s apart | at least 99 % |
| | Eden's memory, and `souls.slice`'s | at most 60 % of its `MemoryMax` (2.4 of 4 GB; 8.4 of 14 GB) |
| | the driver's stream (`STREAM`) and the viewers' (`VIEWER_URL`) | each `pointer` answers |
| | the gateway (`GATEWAY`) | connects |
| During the rung (abort: driver and viewers stopped, `abort.txt`, the run stops) | Eden's ticks on time over the last 30 s | below 95 % |
| | Eden's memory, or `souls.slice`'s | above 85 % of its `MemoryMax` (3.4 of 4 GB; 11.9 of 14 GB) |
| | the probe | silent for 30 s |

An aborted rung is in the table as `aborted by the guard (<reason>)`, beside what it measured until the stop.
`limits.sh` exits 4 after an abort or a refusal, and 0 when every rung ran.

## The run

Variables used below. `PROD` and `BUILD` are the release owner's SSH names for the production machine and the build
machine. `REL` is the live release's checkout on the production machine (`/srv/sim-worlds/production`). `L` is the
run's folder on the build machine. `LO` is the loopback address on both machines.

**1. The kit on the build machine.** Use a checkout of the commit production runs, with this change in it, on
Linux x86-64 with rustup and Node 22.18 or later:

```sh
pnpm install --frozen-lockfile
bash v2/tools/bench/stage2a/kit.sh .local/eden.facts.json .local/limits-kit.tar.gz   # any facts: only the drill seeds
```

Or reuse an unpacked kit: the served run uses only the driver, `loads.mjs`, the readers and replica's package.

**2. The guard on the production machine.** If `$REL` has no `v2/tools/bench/stage2a/guard.mjs`, copy this commit's
`guard.mjs` and `v2/tools/ops/health/read.mjs` into a private folder there, at the same relative paths. Check that
the user you run it as can read the worlds root:

```sh
ssh "$PROD" "node $REL/v2/tools/bench/stage2a/guard.mjs probe --every 5" | head -1   # one line: Eden's state, memory, worlds
```

**3. The test Souls.** On the directory machine, following [operator test Souls](test-souls.md), pair 500 test
Souls into a private tokens file outside the repository. Copy the file to `$L/souls.tokens` on the build machine
with mode 0600, and never anywhere else:

```sh
ssh "$PROD" 'DIRECTORY_ORIGIN=<its loopback origin> node $REL/v2/tools/ops/test-soul pair eden 500 --directory "$DIRECTORY_ORIGIN" --out <private>/souls.tokens'
```

**4. The forward and the run, on the build machine,** in `screen` or `tmux`. Choose the cores of a timed runner
with no job running (`souls-timed-<n>` owns physical cores 3(n-1) to 3n-1 and their siblings, +24). The stream
path is Eden's `views/world.json` `stream`, printed by the preflight as `stream ...`:

```sh
ssh -fN -o ExitOnForwardFailure=yes -L "$LO:17330:$LO:7330" -L "$LO:17320:$LO:7320" "$PROD"
S=<the stream path, no leading or trailing slash>
GATEWAY=ws://$LO:17330 TOKENS_FILE=$L/souls.tokens \
  STREAM=http://$LO:17320/$S/ VIEWER_URL=https://soul.game/s/$S/ \
  PROBE="ssh $PROD node $REL/v2/tools/bench/stage2a/guard.mjs probe --every 5" \
  DRIVER_CPUS=<the runner's cores> OUT=$L/run \
  bash v2/tools/bench/stage2a/limits.sh
```

These defaults give the count 500, `every4`, 100 viewers, 600 s a rung, `even uneven`, two repeats: 4 rungs. The
first preflight runs before any load. A wrong `S` is refused there, not mid-run. If the build machine has no SSH
access to `$PROD`, the release owner gives it a key for an ordinary user before the run. Do not relay through the
laptop: that would put the laptop's network in every receipt.

**5. After the run.** On the directory machine, `test-soul retire-all eden`, then delete the tokens file on both
machines. Close the forward (`pkill -f "$LO:17330:$LO:7330"` on the build machine). Paste `$L/run/table.md` into
[capacity](../../../docs/architecture/capacity.md) with the preflight lines from `$L/run/run.txt`, which give each
world's state, Eden's memory and the gateway's connect time.

**Join time and frame rate** are read from the old page in a real browser, at `https://soul.game/w/eden/` during
a rung. That is P3's own step, not this script's.

## How long it takes

A served rung is its load (`SECS`, 600) plus about 60 s: the preflight (about 12 s), the driver's sign-in of 500
Souls and its rise, its 15 s drain, and the teardown. 4 rungs take **about 45 minutes**. Add about 5 minutes for
pairing 500 test Souls. The drill below (24 Nov 2026, 100 agents, 90 s a rung) took 149 s a rung.

## The limits it judges

Fixed before any run (`limits.mjs`), from the master view's limits:

| Limit | Bar | Read from |
|---|---|---|
| Receipt | send to accepted or refused, p50 ≤ 100 ms, p95 ≤ 300 ms | the driver |
| Viewer delay | a part's arrival at a viewer after its end in world time, p50 ≤ 1 s, p95 ≤ 2 s, and not growing (last minute's p50 at most 1.5 times the first's, and at most 250 ms more) | the readers; the driver's stream reader when `VIEWERS=0` |
| Ticks on time | ≥ 99 in 100 over the load window | Eden's health (the guard's samples) |
| Stuck Souls | 0 (the driver's rule, `stuck.rule` in its report) | the driver |
| No result | a rung that gives none: a world, gateway or driver ended | the rung's folder |
| Aborted | the guard stopped the rung | `abort.txt` |
| Memory | world, gateway and origin together ≤ `MEM_LIMIT_MB`, when set (served: Eden's whole cgroup) | the sampler, or the guard |

Reported beside them, not judged: refusals by cause, send to the first visible move, and the viewers' first picture
and drops. In the served run, processor cores read 0: the guard reads no process's counters on the production
machine. **Not measured by this run:** join time and frame rate (the browser step above), and read time, start time
and action time. The readers' viewer delay ends when a part is in the viewer's hands. The page then plays it 2 s
behind the world by design (`BEHIND_US`, `apps/web/src/v2-engine/source/clock.ts`), which the browser step sees.

## Drill: the served run against a stand-in

On a Linux machine that serves nothing, from an unpacked kit, `served-drill.sh` stands up a stand-in production
machine under `OUT`. That is a seeded Eden with its gatewayd and origin on loopback, a worlds root with a second
world asleep, and a cgroup tree whose Eden memory follows worldd's against 4G and 14G. It then runs `limits.sh`'s
served run against it, with the probe on the stand-in's files. `DRILL_ABORT_AT=30` raises Eden's memory to 90 % of
its `MemoryMax` 30 s into the load, so the guard must stop it:

```sh
OUT=.local/d1 SECS=90 VIEWERS=50 DRIVER_CPUS=16-17,40-41 bash v2/tools/bench/stage2a/served-drill.sh 100
OUT=.local/d2 SECS=90 VIEWERS=50 DRIVER_CPUS=16-17,40-41 DRILL_ABORT_AT=30 bash v2/tools/bench/stage2a/served-drill.sh 100
```

## The throwaway run

Without `GATEWAY`, `limits.sh` runs the earlier form. Each rung (`rung.sh`) seeds its own Eden from Eden's facts
into its own folder under `.local/`. It runs `worldd serve`, a `gatewayd` and an origin on loopback ports the
kernel picks, with no unit, no directory entry and no proxy route. It climbs 100, 250, 500, 750 and 1,000 agents,
`VIEWERS` defaulting to 500, and stops after the first count where a limit gave way (`STOP=0` runs every count).
Placement: `WORLD_CPUS` for the world's processes, `DRIVER_CPUS` (and `VIEWER_CPUS`) for the load. It refuses a
folder under `/var/lib/souls` or `/etc/souls`. Its dry run on the build machine (24 Nov 2026: 100 and 500 agents,
even and uneven, two repeats, 120 s a rung, 500 viewers) took 24 minutes for 8 rungs:

```sh
SECS=120 STOP=0 WORLD_CPUS=12-15,36-39 DRIVER_CPUS=16-17,40-41 bash v2/tools/bench/stage2a/limits.sh "100 500"
```

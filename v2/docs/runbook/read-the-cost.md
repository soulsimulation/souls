# Read what a world costs

Engine v2 O11 (#2721). Dollars per world per day, by part: processor, memory, local disk, stored bytes, uploads and
bytes served. Code and the one unit-price file: `v2/tools/ops/cost/`.

## How it is worked out

- **Cost is use times a unit price.** Every unit price is in `v2/tools/ops/cost/prices.json`, each with its date and
  its source (a test refuses one without). When a price moves, change it there with the new date and source.
- **The machine is rented at a fixed price.** Its day's price (the month's over 30.44 days, in dollars at the dated
  euro rate) is split by part (`split`: processor 0.5, memory 0.4, local disk 0.1 by default). A part's unit price is
  its share over the machine's size: a core-second, a memory GiB-hour, a local-disk GB-hour. Each world is charged
  what it used. What no world used is the line **unused**, priced from the machine's size less the worlds' use; the
  gateway, the origin and the system count there too. The worlds plus "unused" equal the machine's price; the page
  says how far apart they are, and `page` exits 1 past 1 %.
- **Stored bytes, uploads and bytes served** are priced per unit (object storage, its write fee, traffic).
- **A part with no meter reads "not metered"**, never $0.00. Stored bytes and uploads read so until V3 (history to the
  object store) meters them. A world's total then ends "+ not metered".

The machine's size in `prices.json` (`machine`) is the production machine's, from its `v2/tools/ops/machine-facts.sh`
line of 18 Nov 2026. Its price is an example: replace it with the invoice, with its date, before reading the figures
as a bill.

## Run the meter

As the user that owns `$WORLDS_ROOT`, sample every minute (a loop, or a timer running `sample`):

```sh
node v2/tools/ops/cost/cost.mjs run "$WORLDS_ROOT" 60
```

Each sample appends one line per world to `$WORLDS_ROOT/health/cost/<UTC day>.jsonl`:

- **processor and memory** of the world's process (`worldd@<world>`'s MainPID), read from `/proc`. A world with no
  process (stopped by hand, or asleep once O2 exists) uses neither, and costs only its folder on the disk.
- **local disk**: the bytes under `$WORLDS_ROOT/worlds/<world>`.
- **bytes served**: the origin's counters. Start the origin with `ORIGIN_STATS=$WORLDS_ROOT/health/origin-stats.json`
  and it writes the bytes it has served by the stream path's first segment, the world's name, every 10 s. Without
  the file, bytes served read "not metered".

## Read the page

```sh
node v2/tools/ops/cost/cost.mjs page "$WORLDS_ROOT"            # today so far
node v2/tools/ops/cost/cost.mjs page "$WORLDS_ROOT" 2026-11-18 # a whole day
```

It prints the table and writes it to `$WORLDS_ROOT/health/cost.html`, mode 0600: the machine's owner reads it (copy
it off the machine to open it); nothing serves it. One row per world, then "unused", then the machine. A cell under a
cent reads "under $0.01".

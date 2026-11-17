# World time

Engine v2 T5 (#2643), contract T5 in [TRUNK.md](TRUNK.md). It fixes world time as its own line, so that a different
tick rate, a tempo change or a world that slept never changes when anything happens. Code:
`v2/crates/replica/src/time.rs`. Fixtures: `v2/crates/replica/fixtures/time/`. Checks: `crates/replica/tests/time.rs`
natively, and the `time-goldens` step of `v2/tools/ci.sh` for the WASM build. The clock thread (K7), the due list
(K9) and moves on the beat (B8) are not here.

## The line

1. **World time is a signed 64-bit count of microseconds from the world's start** (`Micros`). A duration is
   microseconds and a rate is a whole number per second; a kind never states either in ticks. Nothing is rounded to
   a tick when it is stored, only when it is scheduled (rule 6). 64 bits of microseconds last 292,000 years of world
   time. World time is an `i64` everywhere; a JavaScript reader holds one beyond 2^53 as a `BigInt` (encoding rule
   5), never as a number. 2^53 µs is 285 years of world time, which a world at mapping rate r passes in 285/r real
   years: at 60 (a world minute each real second) in about 4.75 years, at 1,000 in about 104 days.
2. **Three effects in the log say how world time relates to everything else:** the mapping to real time, the tick
   rate and the tempo (`TimeEffect`). None is a constant. A world's start writes one of each, anchored at world time
   0, tick 0 and beat 0, or is refused as `start-not-at-zero`. A later effect's anchor is tied to when it is written
   (its envelope's world time, T6): it is the first world time, tick or beat at or after that time. Earlier would
   renumber what the world has passed (`anchor-in-past`). Later is a change held for a time, which is the agent's
   client's to schedule, not the engine's (`anchor-in-future`, T10). An effect must also continue the one before
   (rules 3, 6 and 7). A refused effect changes nothing. The clock thread (K7) writes each effect when it applies.
3. **The mapping** is a world-time anchor, a real-time anchor and a rate, world microseconds per real microsecond,
   as a fraction. A rate of zero or below would stop or reverse world time, and is refused as
   `mapping-rate-not-positive`, whether built in code or read from a log. A new mapping's world anchor must be the
   world time the mapping before gives at its real anchor (`mapping-not-continuous`): world time never jumps. A
   reading before the first mapping's real anchor is refused as `before-world-start`, as a tick or beat query is.
4. **Every line is computed from its anchor: multiply, then divide, through 128 bits.** The count reached at a time
   (tick n, beat k, a world time from a real one) rounds down. The time a count is reached (a tick's start, a beat's
   time) is the first whole microsecond at or after it: it rounds up. Never add a rounded period: at 130 a minute a
   beat is 461,538.46 µs, and a million added periods land 461,539 µs early (Step 0 below). These lines only rise,
   and the rule lives in one type, `Line` with `Fraction`, available to any later use that rises with world time and
   rounds down. A use that falls, curves or rounds otherwise states its own rule (T4's tracks round a pose to the
   nearest unit, `pose.md` rule 8). A value that can fall (a timed value: a candle shortening) is F5's (#2770),
   which follows SA-F5a (#2845): its value rounds toward zero, not down (a candle losing 1 a second reads no change
   0.5 s after it is set, where a floor would read −1), and its crossing rounds up.
5. **Every fraction is positive and its parts fit 32 bits** (`fraction-not-positive`, `fraction-too-wide`), so a
   product is below 2^64 × 2^32 = 2^96 and cannot overflow 128 bits at any 64-bit time. A result that does not fit
   64 bits is refused as `out-of-range`.
6. **The tick rate** is an anchor (a world time and the tick that starts there) and ticks per second, from 1
   (`tick-rate-not-positive`) to 1,000,000 (`tick-rate-above-microsecond`). Tick n covers world time
   `[tick_start(n), tick_start(n + 1))`. A new rate starts on a tick of the rate before
   (`tick-rate-not-on-a-tick`), so no tick is skipped or split. A timer due at t is handled in `tick_of(t)`. The
   bound of one tick a microsecond is what makes `tick_of(tick_start(n))` equal n: rounding a start up moves it by
   less than one tick.
7. **The tempo** is an anchor (a world time and the beat that falls there) and a beat's period in microseconds as a
   fraction, at least one microsecond (`tempo-period-not-positive`, `tempo-period-below-microsecond`), for the same
   reason as rule 6. The period is set only through that check. 130 a minute is 60,000,000/130, kept as that
   fraction. Beats are whole numbers. A new tempo starts on a beat of the tempo before (`tempo-not-on-a-beat`).
8. **A time effect's record** is `{1: which, 2: anchor, 3: at, 4: rate}`: a mapping is 1 with world µs, real µs and
   `[num, den]`; a tick rate is 2 with µs, tick and ticks per second; a tempo is 3 with µs, beat and `[num, den]`.
   T6 (#2645) wraps it in the effect envelope.
9. **An event inside a tick carries its own time,** the microsecond it was due, not the tick's start. The envelope's
   world time (T6) is that microsecond.
10. **Real time enters only as a recorded input:** the real anchor of a mapping. Nothing in `replica` or `sim` reads a
    clock; the clock thread (K7) reads it and writes what it read.
11. **World time never stops.** Time a world could not run or write (asleep, restarting, a failed disk) is owed: the
    mapping says what world time it is now, and the world runs every owed tick, exactly, to reach it (K7, K9, O10).

## The fixtures

12. `rates.diag`: a world's start at 20 ticks a second and 130 beats a minute, eight timers and eight beats, and a
    second run whose rate changes to 30 at 1 s and 60 at 2 s, each written during the tick before. In both runs,
    every timer and beat fires once, on the same microsecond, in a tick whose span holds it (80 ticks against 170).
    `goldens.txt`: beat 1,000,000 at 130 a minute (461,538,461,539 µs; 461,538,000,000 by adding), tick starts at 30
    a second, and the three effects' bytes. Native and WASM both give the file exactly.

## What would quietly break this

- **A duration or a deadline stored in ticks.** Its meaning changes with the rate; round only when scheduling.
- **Adding a rounded period** for ticks or beats. The error grows with every step; compute from the anchor.
- **A second copy of this rounding** for a rising, round-down count instead of `Line`. Two copies drift apart.
- **A float anywhere in the arithmetic.** Native and WASM agree on integers, not on every float path.
- **Nanoseconds in 64 bits.** They last 104 days.
- **A JavaScript number past 2^53 µs.** It rounds silently after 285 world years, which a fast world reaches in real
  months (rule 1); use `BigInt`.
- **An effect anchored before or after when it is written.** The first renumbers the past; the second is a timer
  the engine was never meant to hold.
- **Reading the clock inside a tick, or twice.** Replay differs; a real time is recorded once and mapped.
- **Letting a real clock's step back or leap-second smear move world time back.** Machines step or smear differently
  (https://developers.google.com/time/smear); K7 never lets world time go back.
- **Skipping owed ticks to catch up faster,** or slowing the mapping to save cost. World time never stops.
- **A tick rate or tempo changed between ticks or beats.** One would be split or skipped.
- **Mixing round down and round up for one question.** `tick_of(tick_start(n))` must be n.

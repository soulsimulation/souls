# 0001. The event log is the recording; takes are a cache

- Status: proposed
- Date: 2026-11-08
- Issue / PR: #1394

## Context

A world's past is its append-only `events` log folded over its rules: every pose, activity, seat, kernel fact and
god-placed object at any tick is a deterministic function of the genesis seed, the log and the engine's rules
version. The engine cuts recorded takes (pose tracks) every 20 ticks for the viewer, but by default keeps only a
12-second ring in memory; `TAKES_PERSIST=1` writes them to `take_chunks` and `ARCHIVE_TAKES` ships them to R2. A
busy world's takes run to about 3 MB per minute. The maintainer wants to be able to look back at a day's log, pick
the moments that mattered, and render a clip of each from a chosen camera, days or weeks later, and wants engine
upgrades never to make an old log unreplayable.

## Options

1. **Persist and archive takes for every world**, so any past moment streams to the viewer without an engine.
   Cheap to seek; gigabytes per world-day; a second copy of information the log already determines.
2. **Keep only the event log and snapshots; regenerate takes on demand** by refolding to the moment. Nearly free
   to store; costs engine time proportional to the distance from the nearest retained snapshot; needs a replay
   tool, a historical god-scene reconstruction and a take-time-driven clip renderer.
3. **Do nothing**: the past stays replayable in principle, used only by boot and tests; no way to render it.

## Decision

Option 2. The event log is the source and the recording. Takes, snapshots and viewer projections are derived
caches that may be regenerated at any time and are never archived for their own sake. Two properties of the fold are
the contract that this rests on and must be kept green: **determinism** (same seed, log and rules version give the
same hashes) and **forward compatibility** (a newer engine can still refold every log ever written, with behaviour
changes shipped as logged rules facts adopted from a tick onward, never by reinterpreting old events).

## Consequences

- Retroactive recording becomes a tool chain over the log: replay to a range, reconstruct the god scene as of that
  tick, render from a camera spec. Each is a bounded slice under #1394 (#1395 to #1399).
- Replay cost is bounded by snapshot retention. Today's policy (latest five plus the first of each day for seven
  days) means a moment older than a week replays from genesis or from the last logged recovery baseline. Keeping daily
  snapshots indefinitely (#1399) bounds any replay to one day of ticks for a few hundred KB to a few MB per day.
- A reproducible clip is scene-identical, not pixel-identical: the renderer may change; where everything is and
  what is happening may not.
- Forward compatibility is currently enforced by convention (per-reader `canReplayHistory` allowlists, boot refusal
  on an unreplayable log). A corpus gate that refolds frozen dev logs to pinned hashes on every engine change (#1395)
  turns it into a test. Until then, any engine change that moves a historical hash is a defect, not a baseline move.
- Revisit if replay cost on large worlds makes on-demand regeneration impractical even with daily checkpoints, or if
  a product feature needs sub-second seeking across days of history. Either would argue for persisting takes for
  that world, as an addition, not as the source.

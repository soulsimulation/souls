// How old an answer's data is (Engine v2 R10, #2702). Every answer the daemon gives carries `age`: the milliseconds
// since its copy was last confirmed current, on this machine's steady clock (`performance.now()`), never from two
// machines' wall clocks. A copy is confirmed current when the gateway answers a compare (R5b): the scope's hashes at
// version V. Nothing is pushed while a world is still, so the daemon confirms on demand: every answer but an act's
// asks first (R7's refresh).
//
// - **gap**: present while the copy is not known current, with how long and why: `not-connected` (no signed-in socket),
//   `no-answer` (signed in, but the gateway did not confirm in time), `syncing` (a compare under way), `unconfirmed`
//   (an act's answer, which does not ask, from a copy older than FRESH_MS), `replaced` (another client of this Soul
//   holds it), `behind` (the gateway let its socket go for a full queue, #4979). The answer also says `stale: true`.
// - **unchangedMs**: a copy confirmed current whose world has written nothing for ASLEEP_AFTER_MS is a still world, not
//   a stale copy: `unchangedMs`, how long ago it last wrote. (First day, 26 Nov: it was `asleep: { sinceMs }`, which a
//   new agent read as its Soul asleep, a body state of its own.)

/** A copy older than this is not called current without asking (today's PUSHED_FRESH_MS). */
export const FRESH_MS = 8000;
/** A world that has written nothing for this long, its copy confirmed current, is shown as unchanged for that long. */
export const ASLEEP_AFTER_MS = 10_000;

/**
 * The age fields of an answer at steady time `now`. `confirmedAt` is when the copy was last confirmed current,
 * `changedAt` when its version last changed, `cutAt` when the copy stopped being known current (null while it is),
 * `why` the reason, `asked` whether this answer asked the gateway first. Times are steady milliseconds.
 */
export function ageOf({ now, startedAt, confirmedAt, changedAt, cutAt, why, asked = true }) {
  const age = Math.round(now - (confirmedAt ?? startedAt));
  if (cutAt != null) return { age, stale: true, gap: { ms: Math.round(now - cutAt), why } };
  if (!asked && age > FRESH_MS) return { age, stale: true, gap: { ms: Math.round(now - confirmedAt - FRESH_MS), why: 'unconfirmed' } };
  const still = changedAt == null ? 0 : now - changedAt;
  return { age, ...(still >= ASLEEP_AFTER_MS ? { unchangedMs: Math.round(still) } : {}) };
}

// #1960: the world's sync copy seals at most every 250 ms (worldd `syncs::SEAL_EVERY`) and answers a hashes request
// sooner than that from its last seal, at that seal's version. A follow can then end behind the version a receipt or
// an entry named; the daemon follows again FOLLOW_AGAIN_MS later, once the world has sealed the change.

/** How long after a follow that ended behind the daemon follows again: worldd's `SEAL_EVERY`. */
export const FOLLOW_AGAIN_MS = 250;
/** At most this many follows again in a row: past it, the next entry or receipt asks again. */
export const FOLLOW_AGAIN_MOST = 8;

/**
 * Whether a follow that ended at sequence `at` follows again: the copy is behind `owed` (the newest version a receipt
 * or an entry named since sign-in), and fewer than FOLLOW_AGAIN_MOST follows again were made in a row (`again`).
 */
export const followsAgain = ({ at, owed, again }) => at < owed && again < FOLLOW_AGAIN_MOST;

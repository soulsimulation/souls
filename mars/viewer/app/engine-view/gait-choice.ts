// Walk or jog, chosen by the drawing from the ground speed it reads (humans.ts), for a stretch at a time. The engine
// gives a walk one speed (walk 1.4, jog 2.5, run 4.0 m/s: v2 `sim::gaits`) but does not publish which gait it is, so a
// body is drawn jogging when its speed is well above a walk's. A read speed has bumps (a turn, a step around someone, a
// part that came late), so the choice has two thresholds, changes only once the other one has held for DWELL, and is
// kept at least HOLD once made: a walker is never flipped between the Walk and Jog clips from moment to moment.
// A gait the engine names (activity `jog` / `run`) is drawn as soon as it is named.

/** m/s: a body is drawn jogging above this (faster than any walk)... */
export const RUN_ENTER = 2.3;
/** ...and walking again below this: about halfway between a walk's 1.4 and a jog's 2.5. */
export const RUN_LEAVE = 1.9;
/** s: how long the other gait's speed must hold before the drawing changes to it. */
export const DWELL = 0.3;
/** s: the least a gait is drawn once chosen. */
export const HOLD = 1;
/** s: a jump in the clock larger than this (a seek, a long hidden tab) starts the choice afresh. */
const GAP = 1;

export type GaitChoice = { running: boolean; since: number; at: number; pending?: number };

/** The next choice at time `t` (s) for ground speed `speed` (m/s); `named`: the engine names a jog or a run. */
export function chooseGait(prev: GaitChoice | undefined, speed: number, t: number, named = false): GaitChoice {
  if (named) return prev?.running && t >= prev.since && t - prev.at <= GAP ? { ...prev, at: t, pending: undefined } : { running: true, since: t, at: t };
  if (!prev || t < prev.at || t - prev.at > GAP) return { running: speed > RUN_ENTER, since: t, at: t };
  const other = prev.running ? speed < RUN_LEAVE : speed > RUN_ENTER;
  if (!other) return { running: prev.running, since: prev.since, at: t };
  const pending = prev.pending ?? t;
  if (t - pending >= DWELL && t - prev.since >= HOLD) return { running: !prev.running, since: t, at: t };
  return { running: prev.running, since: prev.since, at: t, pending };
}

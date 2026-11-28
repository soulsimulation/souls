// The native carry playback of a past window (history.ts): one seeked bundle fed through a window's bridge and, for a
// native carry, the window's fork of the page's carried parts. Loaded the first time a past window is played, so the
// page's first load does not carry it (the bundle gate: history.ts is in a chunk every visitor loads).
import type { CarriedParts } from './take-parts.ts';
import type { V2Bridge } from './bridge.ts';
import type { Seeked } from './history-worker.ts';

/** Feeds bundle `s` to `bridge` (and `parts`), calling `take` after each change and each `step` µs of quiet between a
 *  timeline's transitions. A validated timeline starts with an as-at baseline, then exact source-ordered replacements
 *  and removals: future births, frames or membership are not applied to the baseline; bridge chunks are collected as
 *  each change lands. `first`: the window's first bundle, which plays from the moment asked for. */
export function feedBundle(s: Seeked, bridge: V2Bridge, parts: CarriedParts | undefined, take: () => void, first: boolean, step: number): void {
  const feed = (time: number, nodes: Seeked['nodes'], removed: string[], samples: Seeked['samples'], carryChanges: Seeked['carryChanges']) => {
    const message = { t: 'part' as const, p: { number: 0, from: time, to: time, nodes, removed, samples, carryChanges, ...(s.courses ? { courses: s.courses } : {}) } };
    bridge.receive(message); parts?.receive(message); take();
  };
  if (s.timeline) {
    const origin = s.timeline.from, changes = s.carryChanges ?? [];
    // Initial nodes already include every effect <= origin. Earlier carry events retain assignment provenance only.
    feed(origin, s.nodes, [], s.samples, changes.filter((c) => c.at <= origin && !c.pose));
    let last = origin;
    for (const t of s.timeline.transitions) {
      for (let q = last + step; q < t.at; q += step) { bridge.receive({ t: 'pointer', p: { newest: null, newestTo: null, period: 0, anchorWorld: 0, anchorWallMs: 0, quietUntil: q } }); take(); }
      feed(t.at, t.nodes, t.removed, t.samples, changes.filter((c) => last < c.at && c.at <= t.at)); last = t.at;
    }
    const remaining = changes.filter((c) => c.at > last);
    if (remaining.length) feed(Math.max(last, ...remaining.map((c) => c.at)), [], [], [], remaining);
  } else {
    if (parts) throw Error('history: validated node timeline required for native carry playback');
    feed(first ? s.at : s.start, s.nodes, [], s.samples, s.carryChanges);
  }
}

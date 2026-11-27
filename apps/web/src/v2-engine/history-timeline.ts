// History-only materialization into the existing integer take schema. Native time remains in the
// worker message; display changes wait for the first tick not before it (0 <= delay <50 ms).
import type { HistoryNode } from './history-worker.ts';
export type HistoryTransition = { at: number; nodes: HistoryNode[]; removed: string[]; courses?: import('./course-samples.ts').CoursePlaces };
export function readTimeline(value: unknown, node: (v: Map<number, unknown>) => HistoryNode, id: (v: never) => string,
  from: number, to: number): { nodes: HistoryNode[]; transitions: HistoryTransition[] } {
  if (!(value instanceof Map) || Number(value.get(1)) !== from || Number(value.get(6)) !== to) throw new Error('history timeline window missing or malformed');
  const nodes = (v: unknown): HistoryNode[] => {
    if (!Array.isArray(v) || v.some((r) => !(r instanceof Map))) throw new Error('history timeline nodes malformed');
    return v.map(node);
  };
  let previous = from;
  const rows = value.get(3);
  if (!Array.isArray(rows)) throw new Error('history timeline transitions missing');
  const transitions = rows.map((r): HistoryTransition => {
    if (!(r instanceof Map)) throw new Error('history timeline transition malformed');
    const at = Number(r.get(1)); if (!Number.isSafeInteger(at)) throw new Error('history timeline time malformed');
    if (at <= from || at < previous || at > to || !Array.isArray(r.get(3))) throw new Error('history timeline transition order/window malformed');
    previous = at;
    return { at, nodes: nodes(r.get(2)), removed: r.get(3).map(id) };
  });
  return { nodes: nodes(value.get(2)), transitions };
}


import type { Frame, RecordedChunk } from './takes.ts';
import type { Seeked } from './history-worker.ts';
type HistorySource = { frame: Omit<Frame, 'datetime'>; hour?: string;
  start: (at: number, end: number, signal?: AbortSignal) => Promise<number>;
  seek: (at: number, now: number, signal?: AbortSignal) => Promise<Seeked>;
  first: (now: number) => Promise<number | null> };
/** Loaded only when recorded chunks are requested; unrelated history clock/config callers stay light. */
export async function historyChunks(source: HistorySource, from: number, to: number, limit: number,
  signal?: AbortSignal, nowTick?: number | null): Promise<RecordedChunk[]> {
  const { V2Bridge, BEHIND_US } = await import('./bridge.ts');
  const { TICKS, TICK_US, positionAt } = await import('./takes.ts');
  const STEP_US = TICKS * TICK_US;
const historyTick = (us: number): number => {
  if (!Number.isSafeInteger(us)) throw new Error('history timeline time is not an exact integer');
  return Math.ceil(us / TICK_US);
};

type Changes = [number, string, string, unknown][];
type Piece = { tracks: Record<string, number[][]>; changes: Changes; events: { t: number }[];
  finalState: { tick: number; entities: Record<string, unknown>; [key: string]: unknown }; [key: string]: unknown };
/** Existing bridge event-boundary pieces become normal one-second takes. Sampling/gesture/seat/facing
 * stays in the bridge; this combines recorded tracks and discrete changes without moving anything. */
class HistoryTakes {
  readonly chunks = new Map<number, RecordedChunk>();
  private last = -Infinity;
  private partial: { from: number; count: number; take: Piece; values: Map<string, string | undefined>; visible: Set<string> } | null = null;
  private readonly from: number;
  private readonly to: number;
  private readonly limit: number;
  constructor(from: number, to: number, limit: number) { this.from = from; this.to = to; this.limit = limit; }
  add(piece: RecordedChunk): void {
    if (piece.fromTick <= this.last) return;
    this.last = piece.fromTick;
    const from = Math.floor(piece.fromTick / TICKS) * TICKS, offset = piece.fromTick - from;
    if (from < this.from || from + TICKS > this.to || this.chunks.size >= this.limit) return;
    const raw = piece.take as unknown as Piece;
    if (!this.partial || this.partial.from !== from) {
      if (offset !== 0) return; // as before, only complete aligned chunks are returned
      this.partial = { from, count: 0, take: { ...raw, id: `v2-${from}`, startTick: from, ticks: TICKS, keyframeEvery: TICKS,
        baselineStateHash: `v2-state-${from}`, finalStateHash: `v2-state-${from + TICKS}`, tracks: {}, changes: [], events: [],
        finalState: { ...raw.finalState, tick: from + TICKS, entities: {} } }, values: new Map(), visible: new Set() };
    }
    const p = this.partial;
    if (offset !== p.count) throw new Error('history take fragments are not contiguous');
    const change = (tick: number, entity: string, field: string, value: unknown) => {
      const key = `${entity}\0${field}`, encoded = JSON.stringify(value);
      if (!p.values.has(key) || p.values.get(key) !== encoded) { p.take.changes.push([tick, entity, field, value]); p.values.set(key, encoded); }
    };
    const visible = new Set(Object.keys(raw.tracks));
    for (const id of p.visible) if (!visible.has(id)) change(offset, id, 'present', false);
    for (const [id, samples] of Object.entries(raw.tracks)) {
      const track = p.take.tracks[id] ??= [];
      for (const s of samples) {
        const next = [offset + s[0], ...s.slice(1)];
        const last = track.at(-1);
        // Two integer keyframes at a discontinuity retain the old endpoint then the new start.
        // Existing replay holds the old value before the tick and selects the new one at it.
        if (!last || last[0] !== next[0] || last.some((v, i) => v !== next[i])) track.push(next);
      }
    }
    for (const [tick, id, field, value] of raw.changes) change(offset + tick, id, field, value);
    p.take.events.push(...raw.events.map((e) => ({ ...e, t: offset + e.t })));
    const entities = p.take.finalState.entities;
    Object.assign(entities, raw.finalState.entities);
    // Environment and other endpoint metadata belong to the last fragment; keep the
    // entity catalogue union needed to replay bodies removed earlier in this second.
    p.take.finalState = { ...raw.finalState, tick: from + TICKS, entities };
    p.visible = visible;
    if ((p.count += piece.toTick - piece.fromTick) === TICKS) {
      for (const [id, track] of Object.entries(p.take.tracks)) {
        const same = (a: number[], b: number[]) => a.slice(1).every((v, i) => v === b[i + 1]);
        p.take.tracks[id] = track.filter((s, i) => i === 0 || i === track.length - 1 || !same(track[i - 1], s) || !same(s, track[i + 1]));
      }
      p.take.changes.sort((a, b) => a[0] - b[0]);
      this.chunks.set(from, { fromTick: from, toTick: from + TICKS, take: p.take }); this.partial = null;
    }
  }
}

    // one-second chunks, as the old /v1/takes gives a past window (B3-4: the live page plays half-second ones)
    const bridge = new V2Bridge(source.frame, source.hour, TICKS, true), composed = new HistoryTakes(from, to, limit), got = composed.chunks, endUs = to * TICK_US;
    const now = (nowTick ?? to) * TICK_US;
    let at = await source.start(from * TICK_US, endUs, signal), first = true, next: number | null = null;
    let takenThrough = -Infinity;
    const take = () => {
      const pieces = bridge.view.takes.chunks; let i = pieces.length;
      while (i > 0 && pieces[i - 1].fromTick > takenThrough) i--;
      for (; i < pieces.length; i++) { composed.add(pieces[i]); takenThrough = pieces[i].fromTick; }
    };
    // Yield between ordered publications; cancellation never publishes a later batch.
    let workStart = performance.now();
    const cooperate = async () => {
      if (signal?.aborted) throw new Error('aborted');
      if (performance.now() - workStart >= 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0)); workStart = performance.now();
        if (signal?.aborted) throw new Error('aborted');
      }
    };
    const known = new Map<string, HistoryNode>(), children = new Map<string, Set<string>>();
    const remember = (n: HistoryNode) => {
      const old = known.get(n.id); if (old?.parent) children.get(old.parent)?.delete(n.id);
      known.set(n.id, n);
      if (n.parent) { let set = children.get(n.parent); if (!set) children.set(n.parent, set = new Set()); set.add(n.id); }
    };
    let cursor = -Infinity;
    const advance = async (us: number) => {
      if (!Number.isFinite(cursor)) cursor = us;
      while (cursor < us && got.size < limit) {
        cursor = Math.min(us, (Math.floor(cursor / STEP_US) + 1) * STEP_US);
        bridge.receive({ t: 'pointer', p: { newest: null, newestTo: null, period: 0, anchorWorld: 0, anchorWallMs: 0, quietUntil: cursor + BEHIND_US } }); take(); await cooperate();
      }
    };
    // a chunk is made once the world is the bridge's lag past it, so the bundle after the window is read too
    while (at < endUs + STEP_US && got.size < limit) {
      if (signal?.aborted) throw new Error('aborted');
      // K3: a window that begins before the world's first moment (a link to its first minute) is read from that moment
      const s = await source.seek(at, now, signal).catch(async (e) => { const f = first ? await source.first(endUs).catch(() => null) : null; if (f === null || f <= at) throw e; at = f; return source.seek(f, now, signal); });
      workStart = performance.now(); await cooperate();
      // the bundle's time, and the quiet after it until the next bundle: a world with no records writes no bundle, so
      // past the newest one (no next yet) the world is as that bundle left it, and a minute ago is played from there
      const until = Math.min(s.next ?? Infinity, endUs + 2 * STEP_US);
      if (!Array.isArray(s.transitions)) throw new Error('history timeline missing');
      let previous = s.at;
      for (const row of s.transitions) {
        historyTick(row.at);
        if (row.at <= s.at || row.at < previous || row.at > s.start + s.length || !Array.isArray(row.nodes) || !Array.isArray(row.removed)) throw new Error('history timeline malformed');
        previous = row.at;
      }
      const initialAt = historyTick(s.at) * TICK_US;
      if (!first) await advance(initialAt);
      const live = new Set(s.nodes.map((n) => n.id)), removed = [...known.keys()].filter((id) => !live.has(id));
      known.clear(); children.clear(); for (const n of s.nodes) remember(n);
      bridge.receive({ t: 'part', p: { number: 0, from: initialAt, to: initialAt, nodes: s.nodes.map((n) => ({ ...n, at: initialAt })), removed, samples: [], ...(s.courses ? { courses: s.courses } : {}) } });
      cursor = Math.max(cursor, initialAt); first = false;
      // Exact native times remain on s. Only the display materialization receives ceil-tick copies.
      // Motion samples are already authorized recorded paths. Read ahead within a stable frame
      // segment as the old converter did, so sparse samples still interpolate instead of becoming stairs.
      const state = new Map(s.nodes.map((n) => [n.id, n]));
      const boundaries: number[] = [];
      for (const row of s.transitions) {
        if (row.removed.length || row.nodes.some((n) => {
          const old = state.get(n.id);
          return !old || n.parent !== old.parent || n.slot !== old.slot || n.at !== row.at || !/:(body|humanoid)@/.test(n.kind);
        })) boundaries.push(row.at);
        for (const id of row.removed) state.delete(id); for (const n of row.nodes) state.set(n.id, n);
      }
      const samples = [...s.samples].sort((a, b) => a[3] - b[3]); let sampleIndex = 0, boundaryIndex = 0;
      const motion = (before: number) => {
        const part: typeof s.samples = [];
        while (sampleIndex < samples.length && samples[sampleIndex][3] < before) {
          const sample = samples[sampleIndex++];
          if (known.has(sample[0]) && known.has(sample[1])) part.push([sample[0], sample[1], sample[2], historyTick(sample[3]) * TICK_US, sample[4], sample[5], sample[6]]);
        }
        if (part.length) bridge.receive({ t: 'part', p: { number: 0, from: cursor, to: cursor, nodes: [], removed: [], samples: part } });
      };
      motion(boundaries[0] ?? until);
      for (let i = 0; i < s.transitions.length && got.size < limit; i++) {
        const row = s.transitions[i]; if (row.at >= until) break;
        const displayAt = historyTick(row.at) * TICK_US; await advance(displayAt);
        const affected = new Set<string>(), pending = row.nodes.map((n) => n.id);
        for (let j = 0; j < pending.length; j++) for (const id of children.get(pending[j]) ?? []) {
          if (!affected.has(id)) { affected.add(id); pending.push(id); }
        }
        for (const id of row.removed) { const old = known.get(id); if (old?.parent) children.get(old.parent)?.delete(id); known.delete(id); }
        for (const n of row.nodes) remember(n);
        const direct = new Set(row.nodes.map((n) => n.id)), refresh: typeof s.samples = [];
        for (const id of affected) {
          const n = known.get(id);
          if (!n?.parent || direct.has(id) || !/:(body|humanoid)@/.test(n.kind)) continue;
          // Reuse the bridge's public frame/slot composition with the recorded local path.
          const path = samples.filter((v) => v[0] === id && v[1] === n.parent && v[2] === n.slot && v[3] >= (n.at ?? s.at))
            .map((v) => ({ at: v[3], p: [v[4], v[5], v[6]] as [number, number, number] }));
          path.unshift({ at: n.at ?? s.at, p: n.pos });
          const p = positionAt(path, row.at) ?? n.pos;
          refresh.push([id, n.parent, n.slot, displayAt, ...p]);
        }
        bridge.receive({ t: 'part', p: { number: 0, from: displayAt, to: displayAt, nodes: row.nodes.map((n) => ({ ...n, at: displayAt })), removed: row.removed, samples: refresh, ...(row.courses ? { courses: row.courses } : {}) } });
        if (s.transitions[i + 1]?.at !== row.at && boundaries[boundaryIndex] === row.at) {
          while (boundaries[boundaryIndex] === row.at) boundaryIndex++;
          motion(boundaries[boundaryIndex] ?? until);
        }
        await cooperate();
      }
      await advance(until);
      next = s.next;
      if (s.next === null || s.next <= at) break;
      at = s.next;
    }
    // K3: a window in a gap (the world was stopped, or before its first served moment) has no chunks: the window as
    // long from the next bundle is played instead, so a replay goes on across the gap
    if (!got.size && next !== null && next > endUs && !signal?.aborted) {
      const from2 = Math.floor(next / TICK_US);
      return historyChunks(source, from2, from2 + (to - from), limit, signal, nowTick ?? to);
    }
    return [...got.values()].sort((a, b) => a.fromTick - b.fromTick).slice(0, limit);
}

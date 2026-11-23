// State in: who is where, as a `Sampler` (seconds → subject poses). The same planner runs on recorded history (take
// chunks, as `/v1/takes` serves them) or on any other source of poses; it asks for nothing else.
import type { Sampler, SubjectPose } from '../../../mars/viewer/engine/camera/shots.ts';

/** The fields of a take chunk this reads (mars-take/4 as served by `/v1/takes`). */
export type HistoryChunk = { fromTick: number; toTick: number; take: {
  dt: number; startTick: number; tracks: Record<string, number[][]>; changes: [number, string, string, unknown][];
  entities0?: Record<string, { kind?: string; body?: BodyRecord }>;
  finalState?: { entities?: Record<string, { kind?: string; body?: BodyRecord }> };
} };
/** The part of a recorded body the camera reads: a humanoid's height, or a floater's ball (centre `hoverHeight` above its position). */
export type BodyRecord = { family?: string; radius?: number; hoverHeight?: number; params?: { height?: number } };
/** Where a body's picture starts above its position, and how tall it is. A floater (a Little Martian, a duck) is its
 *  ball, not a person-high column: framed as one, it sits small at the top of an empty frame. */
export function bodyExtent(body: BodyRecord | null | undefined): { lift: number; height: number } {
  if (body?.family === 'floater' && body.radius! > 0) return { lift: Math.max(0, (body.hoverHeight ?? body.radius!) - body.radius!), height: body.radius! * 2 };
  return { lift: 0, height: body?.params?.height ?? 1.75 };
}
/** A tracked thing that is not a person (a balloon, a boat, a gondola): where it is at a tick. */
export type Thing = { id: string; label: string; at(tick: number): [number, number, number] | null };
export type History = { dt: number; fromTick: number; toTick: number; ids: string[]; things: Thing[]; sampler(fromTick?: number): Sampler; activity(id: string, tick: number): string | null;
  /** The thing a person is aboard at a tick (activity `ride` or `board`, the nearest thing within RIDE_REACH), or null. */
  riding(id: string, tick: number): Thing | null };
export const RIDE_REACH = 4;

const HUMAN = { lift: 0, height: 1.75 };
const POS_Q = 1000, ANG_Q = 1000, TAU = 2 * Math.PI;
const arc = (a: number, b: number) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

/** People in a run of take chunks. Poses are joined across chunks on absolute ticks and interpolated between keyframes. */
export function historyOf(chunks: readonly HistoryChunk[]): History {
  if (!chunks.length) throw Error('camera.history-empty: no take chunks');
  const sorted = [...chunks].sort((a, b) => a.fromTick - b.fromTick), dt = sorted[0].take.dt;
  type Track = { ticks: number[]; pose: [number, number, number, number][]; body: [number, { lift: number; height: number }][]; present: [number, boolean][]; activity: [number, string][] };
  const tracks = new Map<string, Track>(), props = new Map<string, Track & { label: string }>();
  for (const c of sorted) {
    const t0 = c.take.startTick;
    for (const [id, samples] of Object.entries(c.take.tracks)) {
      const kind = c.take.entities0?.[id]?.kind ?? c.take.finalState?.entities?.[id]?.kind ?? (tracks.has(id) ? 'human' : undefined);
      const thing = kind !== 'human' && !tracks.has(id);
      if (thing && !props.has(id)) props.set(id, { ticks: [], pose: [], body: [], present: [], activity: [], label: (c.take.finalState?.entities?.[id] as { label?: string } | undefined)?.label ?? id });
      let tr = thing ? props.get(id) : tracks.get(id);
      if (!tr) tracks.set(id, tr = { ticks: [], pose: [], body: [], present: [], activity: [] });
      if (!thing && c.take.entities0?.[id]?.body) tr.body.push([t0, bodyExtent(c.take.entities0[id].body)]);
      for (const s of samples) {
        const tick = t0 + s[0];
        if (tr.ticks.length && tick <= tr.ticks[tr.ticks.length - 1]) continue;
        tr.ticks.push(tick); tr.pose.push([s[1] / POS_Q, s[2] / POS_Q, s[3] / POS_Q, (s[4] ?? 0) / ANG_Q]);
      }
    }
    for (const [t, id, field, value] of c.take.changes) {
      const tr = tracks.get(id); if (!tr) continue;
      if (field === 'present') tr.present.push([t0 + t, value === true]);
      else if (field === 'activity' && typeof value === 'string') tr.activity.push([t0 + t, value]);
      else if (field === 'body' && value && typeof value === 'object') tr.body.push([t0 + t, bodyExtent(value as BodyRecord)]);
    }
  }
  const at = <T>(list: [number, T][], tick: number, v: T) => { for (const [t, x] of list) { if (t > tick) break; v = x; } return v; };
  const poseAt = (tr: Track, tick: number): SubjectPose | null => {
    const n = tr.ticks.length;
    if (!n || tick < tr.ticks[0] || !at(tr.present, tick, true)) return null;
    let lo = 0, hi = n - 1;
    if (tick >= tr.ticks[hi]) lo = hi; else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr.ticks[m] <= tick) lo = m; else hi = m; }
    const a = tr.pose[lo], b = tr.pose[Math.min(n - 1, lo + 1)], span = tr.ticks[Math.min(n - 1, lo + 1)] - tr.ticks[lo];
    const u = span > 0 ? Math.min(1, Math.max(0, (tick - tr.ticks[lo]) / span)) : 0;
    // the body worn at this tick; before the first record of one, the first recorded (a body is set as a Soul arrives)
    const body = tr.body.length ? at(tr.body, tick, tr.body[0][1]) : HUMAN;
    return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u + body.lift, a[2] + (b[2] - a[2]) * u], yaw: a[3] + arc(a[3], b[3]) * u, height: body.height, kind: 'human' };
  };
  const things: Thing[] = [...props].map(([id, tr]) => ({ id, label: tr.label, at: (tick) => poseAt({ ...tr, present: [] }, tick)?.p ?? null }));
  return {
    things,
    riding: (id, tick) => {
      const tr = tracks.get(id), a = tr ? at<string | null>(tr.activity, tick, null) : null, me = tr && poseAt(tr, tick)?.p;
      if (!me || (a !== 'ride' && a !== 'board')) return null;
      let best: Thing | null = null, bd = RIDE_REACH;
      for (const th of things) { const q = th.at(tick); if (!q) continue; const d = Math.hypot(q[0] - me[0], q[2] - me[2]); if (d < bd) { bd = d; best = th; } }
      return best;
    },
    dt, fromTick: sorted[0].fromTick, toTick: sorted[sorted.length - 1].toTick, ids: [...tracks.keys()].sort(),
    sampler: (fromTick = sorted[0].fromTick) => (t: number) => {
      const out: Record<string, SubjectPose> = {}, tick = fromTick + t / dt;
      for (const [id, tr] of tracks) { const p = poseAt(tr, tick); if (p) out[id] = p; }
      return out;
    },
    activity: (id, tick) => { const tr = tracks.get(id); return tr ? at<string | null>(tr.activity, tick, null) : null; },
  };
}

/** A body's place at one moment, in the world frame (metres), as a new-engine world's history gives it. */
export type PlaceSample = { id: string; at: number; p: [number, number, number] };

/** People from a new-engine world's history (0.135 P3a): bodies' places at moments (µs), joined into the same `History`
 *  the planner reads, in take ticks of `tickUs` (the page's `#t=` moments: 50 ms). A body faces the way it last moved
 *  (the history carries places, not turns; yaw as the moves read it, forward = (cos, sin) on x, z); one that has not moved faces +x. */
export function historyOfPlaces(samples: readonly PlaceSample[], { fromUs, toUs, tickUs = 50_000 }: { fromUs: number; toUs: number; tickUs?: number }): History {
  if (!(toUs > fromUs)) throw Error('camera.history-empty: no span');
  type Track = { ticks: number[]; pose: [number, number, number, number][] };
  const tracks = new Map<string, Track>();
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    let tr = tracks.get(s.id);
    if (!tr) tracks.set(s.id, tr = { ticks: [], pose: [] });
    const tick = s.at / tickUs, last = tr.pose.at(-1);
    if (tr.ticks.length && tick <= tr.ticks.at(-1)!) continue;
    const moved = last && Math.hypot(s.p[0] - last[0], s.p[2] - last[2]) > 0.02;
    tr.ticks.push(tick); tr.pose.push([s.p[0], s.p[1], s.p[2], moved ? Math.atan2(s.p[2] - last[2], s.p[0] - last[0]) : (last?.[3] ?? 0)]);
  }
  const poseAt = (tr: Track, tick: number): SubjectPose | null => {
    const n = tr.ticks.length;
    if (!n || tick < tr.ticks[0]) return null;
    let lo = 0, hi = n - 1;
    if (tick >= tr.ticks[hi]) lo = hi; else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr.ticks[m] <= tick) lo = m; else hi = m; }
    const a = tr.pose[lo], b = tr.pose[Math.min(n - 1, lo + 1)], span = tr.ticks[Math.min(n - 1, lo + 1)] - tr.ticks[lo];
    const u = span > 0 ? Math.min(1, Math.max(0, (tick - tr.ticks[lo]) / span)) : 0;
    return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], yaw: a[3] + arc(a[3], b[3]) * u, height: HUMAN.height, kind: 'human' };
  };
  const dt = tickUs / 1e6, fromTick = fromUs / tickUs, toTick = toUs / tickUs;
  return {
    things: [], riding: () => null, activity: () => null,
    dt, fromTick, toTick, ids: [...tracks.keys()].sort(),
    sampler: (from = fromTick) => (t: number) => {
      const out: Record<string, SubjectPose> = {}, tick = from + t / dt;
      for (const [id, tr] of tracks) { const p = poseAt(tr, tick); if (p) out[id] = p; }
      return out;
    },
  };
}

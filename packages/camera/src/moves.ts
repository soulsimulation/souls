// Candidate camera moves around a subject (one Soul or a group), as plain `path` shot specs.
// A move is defined in the subject's own frame: an angle off the way it faces, a distance that gives the wanted size
// in frame for this lens and aspect, a height. The frame follows a smoothed version of the subject's motion, so the
// camera glides while the subject steps and turns. Pure: (sampler, ids, window) in, keyed poses out.
import type { Key, Sampler, ShotSpec } from '../../../mars/viewer/engine/camera/shots.ts';

type Vec3 = [number, number, number];
const DEG = Math.PI / 180, TAU = 2 * Math.PI;
/** C² ease (smootherstep): zero velocity and acceleration at both ends. */
export const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (6 * u - 15) + 10));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

export const FRAMINGS = ['wide', 'medium', 'close'] as const;
export type Framing = (typeof FRAMINGS)[number];
/** Subject height as a fraction of frame height, the camera's elevation, and where on the body it looks. */
export const FRAMING: Record<Framing, { fill: number; elevation: number; look: number; fov: number }> = {
  wide: { fill: 0.3, elevation: 16, look: 0.5, fov: 50 },
  medium: { fill: 0.5, elevation: 10, look: 0.6, fov: 42 },
  close: { fill: 0.8, elevation: 5, look: 0.72, fov: 36 },
};
export const MOVES = ['track', 'lead', 'chase', 'orbit', 'crane-up', 'crane-down', 'push-in', 'pull-out', 'pan'] as const;
export type MoveKind = (typeof MOVES)[number];
/** An orbit sweeps at most this fast (degrees of arc per second) and this far. */
export const ORBIT = { degPerSecond: 12, maxArc: 130 };
export const MIN_DISTANCE = 1.6, MIN_CAMERA_HEIGHT = 0.45, KEY_STEP = 0.5;

/** The subject the camera works around at one instant: where, which way it faces, how big, how fast. */
export type Anchor = { t: number; p: Vec3; heading: number; frame: number; radius: number; height: number; speed: number; present: boolean };

/** Sample the subject group over [0, duration] every `step` seconds; position and heading are averaged over ±`smooth` s
 *  (the camera's frame over ±2.5·`smooth`), so a step, a turn on the spot or a keyframe seam does not move the camera. */
export function anchorTrack(sampler: Sampler, ids: readonly string[], duration: number, step = 0.25, smooth = 0.8, context?: (t: number) => readonly Vec3[]): Anchor[] {
  const n = Math.max(2, Math.round(duration / step) + 1);
  const raw: { p: Vec3; face: [number, number]; radius: number; height: number; present: boolean }[] = [];
  let last: (typeof raw)[number] | null = null;
  for (let i = 0; i < n; i++) {
    const poses = sampler(i * step), here = ids.map((id) => poses[id]).filter(Boolean);
    if (!here.length) { raw.push(last ? { ...last, present: false } : { p: [0, 0, 0], face: [1, 0], radius: 0.45, height: 1.75, present: false }); continue; }
    const c: Vec3 = [0, 0, 0]; let fx = 0, fz = 0, height = 0;
    for (const s of here) { c[0] += s.p[0] / here.length; c[1] += s.p[1] / here.length; c[2] += s.p[2] / here.length; fx += Math.cos(s.yaw); fz += Math.sin(s.yaw); height = Math.max(height, s.height ?? 1.75); }
    let radius = 0.45; for (const s of here) radius = Math.max(radius, Math.hypot(s.p[0] - c[0], s.p[2] - c[2]) + 0.45);
    if (Math.hypot(fx, fz) / here.length < 0.35 && here.length > 1) {
      // facing each other (a conversation): the readable side is square to the line between them
      const a = here[0].p, b = here[here.length - 1].p, dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
      fx = -dz / l; fz = dx / l;
    }
    // what the subject is part of (the balloon it rides, the wheel it sits on) is framed with it: the anchor grows to hold it
    const extra = context?.(i * step) ?? [];
    if (extra.length) {
      let x0 = c[0] - radius, x1 = c[0] + radius, z0 = c[2] - radius, z1 = c[2] + radius, y0 = c[1], y1 = c[1] + height;
      for (const q of extra) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
      c[0] = (x0 + x1) / 2; c[1] = y0; c[2] = (z0 + z1) / 2; height = y1 - y0; radius = Math.hypot(x1 - x0, z1 - z0) / 2;
    }
    raw.push(last = { p: c, face: [fx, fz], radius, height, present: true });
  }
  const first = raw.find((r) => r.present); if (first) for (const r of raw) { if (r.present) break; Object.assign(r, { ...first, present: false }); }
  const avg = (i: number, w: number) => {
    const k = Math.max(1, Math.round(w / step)), lo = Math.max(0, i - k), hi = Math.min(n - 1, i + k), m = hi - lo + 1;
    const p: Vec3 = [0, 0, 0]; let fx = 0, fz = 0;
    for (let j = lo; j <= hi; j++) { p[0] += raw[j].p[0] / m; p[1] += raw[j].p[1] / m; p[2] += raw[j].p[2] / m; fx += raw[j].face[0]; fz += raw[j].face[1]; }
    return { p, fx, fz };
  };
  const pos = raw.map((_, i) => avg(i, smooth).p);
  const out: Anchor[] = [];
  let prevHeading = 0, prevFrame = 0;
  const near = (a: number, ref: number) => a + Math.round((ref - a) / TAU) * TAU; // unwrap next to the previous angle
  for (let i = 0; i < n; i++) {
    const a = pos[Math.max(0, i - 1)], b = pos[Math.min(n - 1, i + 1)], span = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * step;
    const vx = (b[0] - a[0]) / span, vz = (b[2] - a[2]) / span, speed = Math.hypot(vx, vz);
    const f = avg(i, smooth), wide = avg(i, smooth * 2.5);
    // a walker is read from the way it walks; someone standing from the way it faces
    let heading = speed > 0.35 ? Math.atan2(vz, vx) : Math.atan2(f.fz, f.fx);
    const fa = pos[Math.max(0, i - Math.round(2 / step))], fb = pos[Math.min(n - 1, i + Math.round(2 / step))], fl = Math.hypot(fb[0] - fa[0], fb[2] - fa[2]);
    let frame = fl > 1.2 ? Math.atan2(fb[2] - fa[2], fb[0] - fa[0]) : Math.atan2(wide.fz, wide.fx);
    if (i) { heading = near(heading, prevHeading); frame = near(frame, prevFrame); }
    prevHeading = heading; prevFrame = frame;
    out.push({ t: i * step, p: pos[i], heading, frame, radius: raw[i].radius, height: raw[i].height, speed, present: raw[i].present });
  }
  // the camera's frame turns slowly: one more pass over the unwrapped angle
  const frames = out.map((a) => a.frame), k = Math.max(1, Math.round((smooth * 2.5) / step));
  out.forEach((a, i) => { let s = 0, m = 0; for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { s += frames[j]; m++; } a.frame = s / m; });
  return out;
}

export function anchorAt(track: readonly Anchor[], t: number): Anchor {
  const step = track.length > 1 ? track[1].t - track[0].t : 1, x = Math.max(0, Math.min(track.length - 1, t / step)), i = Math.min(track.length - 1, Math.floor(x)), j = Math.min(track.length - 1, i + 1), u = x - i;
  const a = track[i], b = track[j];
  return { t, p: [lerp(a.p[0], b.p[0], u), lerp(a.p[1], b.p[1], u), lerp(a.p[2], b.p[2], u)], heading: lerp(a.heading, b.heading, u), frame: lerp(a.frame, b.frame, u), radius: lerp(a.radius, b.radius, u), height: lerp(a.height, b.height, u), speed: lerp(a.speed, b.speed, u), present: a.present && b.present };
}

/** How far back the camera sits for the subject to fill `fill` of the frame height and fit its width. */
export function framingDistance(a: Pick<Anchor, 'radius' | 'height'>, framing: Framing, aspect: number, scale = 1): number {
  const f = FRAMING[framing], tv = Math.tan((f.fov * DEG) / 2);
  const tall = a.height / f.fill / (2 * tv), across = (2 * a.radius) / 0.8 / (2 * tv * aspect);
  return Math.max(MIN_DISTANCE, tall, across) * scale;
}

export type MoveOpts = { duration: number; aspect: number; framing: Framing; side: 1 | -1; ground?: (x: number, z: number) => number };
type Rig = { az: number; elevation: number; distance: number; fixed?: boolean };

/** Angle off the subject's facing (0 = straight in front of it), elevation and distance scale through the move (u in 0..1). */
function rig(kind: MoveKind, u: number, o: MoveOpts): Rig {
  const e = ease(u), el = FRAMING[o.framing].elevation, s = o.side;
  switch (kind) {
    case 'track': return { az: s * 55, elevation: el, distance: 1 };
    case 'lead': return { az: s * 14, elevation: el * 0.8, distance: 1.1 };
    case 'chase': return { az: s * 158, elevation: el + 6, distance: 1.15 };
    case 'orbit': { const arc = Math.min(ORBIT.maxArc, ORBIT.degPerSecond * o.duration); return { az: s * lerp(15 + arc / 2, 15 - arc / 2, e), elevation: el, distance: 1.05 }; }
    case 'crane-up': return { az: s * 35, elevation: lerp(3, 30, e), distance: lerp(0.9, 1.6, e) };
    case 'crane-down': return { az: s * 35, elevation: lerp(30, 3, e), distance: lerp(1.6, 0.9, e) };
    case 'push-in': return { az: s * 25, elevation: lerp(el + 4, el, e), distance: lerp(2.1, 0.95, e) };
    case 'pull-out': return { az: s * 25, elevation: lerp(el, el + 6, e), distance: lerp(0.95, 2.1, e) };
    case 'pan': return { az: s * 60, elevation: el + 2, distance: 1.35, fixed: true };
  }
}

/** One move as a `path` shot over [0, duration]: a key every KEY_STEP seconds, joined by the engine's Catmull-Rom. */
export function moveSpec(kind: MoveKind, track: readonly Anchor[], subjects: readonly string[], o: MoveOpts): ShotSpec {
  const f = FRAMING[o.framing], ground = o.ground ?? (() => 0), n = Math.max(2, Math.round(o.duration / KEY_STEP) + 1), keys: Key[] = [];
  const mid = anchorAt(track, o.duration / 2);
  for (let i = 0; i < n; i++) {
    const t = Math.min(o.duration, i * KEY_STEP), a = anchorAt(track, t), r = rig(kind, t / o.duration, o), base = r.fixed ? mid : a;
    const az = base.frame + r.az * DEG, elev = r.elevation * DEG, d = framingDistance(base, o.framing, o.aspect, r.distance), look = a.height * f.look;
    const position: Vec3 = [base.p[0] + Math.cos(elev) * Math.cos(az) * d, base.p[1] + base.height * f.look + Math.sin(elev) * d, base.p[2] + Math.cos(elev) * Math.sin(az) * d];
    position[1] = Math.max(position[1], ground(position[0], position[2]) + MIN_CAMERA_HEIGHT);
    // lead room: a walker is framed a little behind centre, with space ahead of it
    const ahead = Math.min(1, a.speed / 1.2) * 0.1 * d;
    keys.push({ t, position, target: [a.p[0] + Math.cos(a.heading) * ahead, a.p[1] + look, a.p[2] + Math.sin(a.heading) * ahead] });
  }
  return { kind: 'path', keys, fov: f.fov, subjects: [...subjects] };
}

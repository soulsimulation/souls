// A Soul's sight as text (0.131 parity C17, #3687): today's `view --alt-only` caption (apps/server/src/edge/eyes/sight.ts,
// `computeSight` and `caption`), ported onto what the page draws on this machine. Pure and deterministic: the same
// drawn moment gives the same words. No model turn and no server: `view.mjs` reads the input from the site's own page
// in the headless browser `shoot` uses (the public stream), the same moment its picture is taken at, so words and
// picture agree.
//
// The rule is today's, in v2's tree (v2/tools/import-eden): what is in the same enclosure as the eyes (the same
// `eden:room`, or both out of every room), on the same level for a body, within the light's range, inside the
// 90° field around the gaze, and with no tall solid (1.5 m or more, spanning the eye's height) on the straight line
// in plan between the eyes and it. A thing's own solids never hide it.

const TAU = Math.PI * 2;
export const HFOV = Math.PI / 2;
export const wrap = (a) => { let x = a % TAU; if (x > Math.PI) x -= TAU; if (x < -Math.PI) x += TAU; return x; };
const r1 = (n) => Math.round(n * 10) / 10, r3 = (n) => Math.round(n * 1000) / 1000;

/** A direction in plan (x east, z south) as degrees from north and a compass word. */
export function compassOf(dx, dz) {
  const d = ((Math.round(Math.atan2(dx, -dz) * 180 / Math.PI) % 360) + 360) % 360;
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return { degrees: d, compass: names[Math.round(d / 45) % 8] };
}

/** Where a bearing (relative to the gaze, + = right) falls in the frame, left to right: today's words. */
export function sideOf(rel, hfov = HFOV) {
  const f = rel / (hfov / 2);
  return f < -0.6 ? 'far left' : f < -0.2 ? 'left' : f < -0.07 ? 'ahead-left' : f <= 0.07 ? 'ahead' : f <= 0.2 ? 'ahead-right' : f <= 0.6 ? 'right' : 'far right';
}

/** The light at world clock `hh:mm`, today's bands; null clock reads as day. */
export function lightOf(clock, indoors) {
  const m = clock ? Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) : NaN;
  const label = !Number.isFinite(m) ? 'day' : m < 330 || m >= 1260 ? 'night' : m < 420 ? 'morning' : m < 1080 ? 'day' : m < 1170 ? 'evening' : 'dusk';
  return { clock: Number.isFinite(m) ? clock : null, label, dark: label === 'night' && !indoors };
}
/** How far the Soul makes out people (m): today's. Dark outdoors shortens sight; indoors rooms are lit. */
export const sightRange = (light, indoors) => (indoors ? 40 : light.label === 'night' ? 14 : light.label === 'dusk' || light.label === 'morning' ? 30 : 60);

const cross = (ax, az, bx, bz) => ax * bz - az * bx;
function segsCross(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = cross(r[0], r[1], s[0], s[1]);
  if (Math.abs(den) < 1e-12) return false;
  const t = cross(c[0] - a[0], c[1] - a[1], s[0], s[1]) / den, u = cross(c[0] - a[0], c[1] - a[1], r[0], r[1]) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1;
}
export function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const polyArea = (p) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const centroid = (p) => [p.reduce((s, a) => s + a[0], 0) / p.length, p.reduce((s, a) => s + a[1], 0) / p.length];

/** Is the line in plan from the eyes `e` to `t` clear of every block (a tall solid's footprint)? `skip` names the
 *  target's own; a block holding either end does not count (a Soul in a chair, a thing on a counter). */
export function clearLine(blocks, e, t, skip = () => false) {
  for (const b of blocks) {
    if (skip(b.owner)) continue;
    if (inPoly(e[0], e[1], b.poly) || inPoly(t[0], t[1], b.poly)) continue;
    const p = b.poly;
    for (let i = 0; i < p.length; i++) if (segsCross(e, t, p[i], p[(i + 1) % p.length])) return false;
  }
  return true;
}

const clean = (s, n = 48) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const m = (d) => (d < 10 ? `${r1(d)} m` : `${Math.round(d)} m`);
const art = (name) => (/^(the|a|an)\s/i.test(name) ? name : `the ${name}`);

/**
 * What the eyes see, and today's caption of it. `input` is what `view.mjs` gathers from the page:
 * `{ clock, me: {id, name, p, room, inside, building}, eye, target, bodies: [{id, name, p, room}],
 *    things: [{id, name, p, room, place?}], areas: [{id, name, outline}], blocks: [{owner, poly, room}] }`,
 * positions world metres `[x, y, z]`, outlines `[[x, z] …]` metres.
 */
export function computeSight(input) {
  const { me } = input, e = [input.eye[0], input.eye[2]];
  const g = Math.atan2(input.target[2] - input.eye[2], input.target[0] - input.eye[0]), half = HFOV / 2;
  const indoors = !!me.inside, light = lightOf(input.clock ?? null, indoors), range = sightRange(light, indoors);
  const rel = (t) => wrap(Math.atan2(t[1] - e[1], t[0] - e[0]) - g);
  // Interior walls and furniture matter only from inside their room; outer walls from outside.
  const blocks = (input.blocks ?? []).filter((b) => (b.room ?? null) === (me.room ?? null));
  const clear = (t, skip) => clearLine(blocks, e, t, skip);
  const souls = [];
  for (const o of input.bodies ?? []) {
    if (o.id === me.id || !o.p) continue;
    const t = [o.p[0], o.p[2]], d = Math.hypot(t[0] - e[0], t[1] - e[1]);
    if (d > range || (o.room ?? null) !== (me.room ?? null) || Math.abs(o.p[1] - me.p[1]) > 2) continue;
    const b = rel(t);
    if (Math.abs(b) > half + Math.atan2(0.35, Math.max(d, 0.35))) continue;
    if (d > 0.6 && !clear(t, (id) => id === o.id)) continue;
    souls.push({ id: o.id, name: clean(o.name), distance: r1(d), bearing: r3(b), side: sideOf(b) });
  }
  const things = [];
  const point = (x, kind, t, max) => {
    const d = Math.hypot(t[0] - e[0], t[1] - e[1]);
    if (d > max || d < 0.3) return;
    const b = rel(t);
    if (Math.abs(b) > half + Math.atan2(0.5, Math.max(d, 0.5))) return;
    if (!clear(t, (id) => id === x.id)) return;
    things.push({ id: x.id, name: clean(x.name), kind, distance: r1(d), bearing: r3(b), side: sideOf(b) });
  };
  for (const x of input.things ?? []) {
    if (!x.p || (x.room ?? null) !== (me.room ?? null) || x.id === me.room || x.id === me.building) continue;
    if (x.place && !indoors) continue; // a building is a landmark, below
    if (!x.place) point(x, 'thing', [x.p[0], x.p[2]], Math.min(range, 25));
  }
  // Landmarks, outdoors: buildings and named areas not holding me, by the nearest point of their outline in view.
  if (!indoors) {
    const max = light.label === 'night' ? 40 : 120;
    for (const x of input.things ?? []) {
      if (!x.place || !x.p || (x.room ?? null) !== null) continue;
      point(x, 'place', [x.p[0], x.p[2]], max);
    }
    for (const a of input.areas ?? []) {
      const p = a.outline;
      if (!p || p.length < 3 || inPoly(e[0], e[1], p)) continue;
      const c = centroid(p), pts = [c, ...p].filter((q) => Math.abs(rel(q)) <= half);
      if (!pts.length) continue;
      const aim = pts.reduce((best, q) => (Math.hypot(q[0] - e[0], q[1] - e[1]) < Math.hypot(best[0] - e[0], best[1] - e[1]) ? q : best));
      const d = Math.hypot(aim[0] - e[0], aim[1] - e[1]);
      if (d > max || !clear(aim, (id) => id === a.id)) continue;
      const b = rel(aim);
      things.push({ id: a.id, name: clean(a.name), kind: 'place', distance: r1(d), bearing: r3(b), side: sideOf(b) });
    }
  }
  // Repeated things with one name are one line (six camp chairs), the nearest the anchor.
  const grouped = new Map();
  for (const t of things.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))) {
    const key = `${t.kind}:${t.name.replace(/\s+\d+$/, '').toLowerCase()}`, have = grouped.get(key);
    if (have) have.count = (have.count ?? 1) + 1;
    else grouped.set(key, { ...t });
  }
  const thingList = [...grouped.values()].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 10);
  souls.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const heading = { yaw: r3(g), ...compassOf(Math.cos(g), Math.sin(g)) };
  let place = null;
  if (!indoors) {
    const holding = (input.areas ?? []).filter((a) => a.outline?.length >= 3 && inPoly(e[0], e[1], a.outline));
    place = holding.sort((a, b) => polyArea(a.outline) - polyArea(b.outline))[0]?.name ?? null;
  }
  const where = { inside: indoors, enclosure: indoors ? clean(me.buildingName ?? me.roomName ?? '') || null : null, room: indoors ? clean(me.roomName ?? '') || null : null, place: place && clean(place) };
  const sight = { heading, where, light, range, souls, things: thingList, alt: '' };
  sight.alt = caption(sight, clean(me.name) || 'This Soul');
  return sight;
}

/** One paragraph, left to right, from the same visible set the picture shows: today's caption. */
export function caption(s, name) {
  const head = `looking ${s.heading.compass}`;
  const where = s.where.inside ? `inside ${s.where.enclosure ?? 'a building'}${s.where.room && s.where.room !== s.where.enclosure ? ` (${s.where.room})` : ''}` : s.where.place ? `at ${s.where.place}` : 'outdoors';
  const light = `${s.light.clock ? `${s.light.clock}, ` : ''}${s.light.label}${s.where.inside ? ', indoors' : s.light.dark ? ' (dark: only nearby things are clear)' : ''}`;
  const near = s.souls.slice(0, 8).map((o) => ({ b: o.bearing, d: o.distance, text: `${o.name}, ${m(o.distance)} ${o.side}` }));
  const close = s.things.filter((t) => t.kind !== 'place' && t.distance <= 15).slice(0, 6).map((t) => ({
    b: t.bearing, d: t.distance,
    text: t.count > 1 ? `${t.count} × ${t.name.replace(/\s+\d+$/, '').toLowerCase()} (nearest ${t.name}, ${m(t.distance)} ${t.side})` : `${art(t.name)} ${m(t.distance)} ${t.side}`,
  }));
  const ltr = [...near, ...close].sort((a, b) => a.b - b.b || a.d - b.d).map((x) => x.text);
  const far = s.things.filter((t) => t.kind === 'place' || t.distance > 15).slice(0, 5).sort((a, b) => a.bearing - b.bearing).map((t) => `${art(t.name)} ${m(t.distance)} ${t.side}`);
  const more = s.souls.length > 8 ? ` and ${s.souls.length - 8} more people` : '';
  const people = s.souls.length === 0 ? 'Nobody else is in view.' : s.souls.length === 1 ? 'One other person is in view.' : `${s.souls.length} other people are in view.`;
  return `${name} sees this, ${where}, ${head} (${light}). `
    + (ltr.length ? `Left to right: ${ltr.join('; ')}${more}. ` : '') + (far.length ? `Further off: ${far.join('; ')}. ` : '') + people
    + ' Only what is in front of the eyes is shown: nothing behind, nothing through walls.';
}

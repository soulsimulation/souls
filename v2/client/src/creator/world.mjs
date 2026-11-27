// The world's weather, sky and lightning as a creator's edit (#3695, today's `weather`, `sky` and `strike`): each verb
// is plain sets on the world's own node (`replica::sky`), made here from the daemon's copy and sent as any edit is, so
// it is checked, recorded and refused as any edit is. The world writes E6's weather event and the weather's timer after
// the batch commits (`worldd` `put_weather`, `sim::edit::weather`); the page draws the sky palette and the strike.
//
//   weather [--kind clear|cloudy|rain|wind|fog|storm] [--clouds 0..1] [--rain 0..1] [--wind 0..1] [--minutes 5..360]
//   sky --palette <name>
//   strike <x,z | id>                 metres on the open ground, or a place or thing (its outline's middle, or its spot)
//   time <HH:MM | live>               the hour the page draws the sky at, for a staged scene; the world's clock, its
//                                     Souls' clocks and calendars never change (world time never stops or slows)
//   arrival <place> | --clear         where new Souls arrive (#5006, `replica::arrival`): a place of the world, by its id
//                                     or its facts id; births ring round its middle from the next one, with no restart
//
// A refusal is by name, with what was wrong, before anything is sent. Levels are today's 0 to 1 and E6's 0 to 100.

import { allFields, decode, idText } from '../brief/copy.mjs';

/** E6's fields on the world node (`v2/crates/replica/src/sky.rs`). */
export const SKY = { DAY_S: 60, WEATHER_UNTIL: 65, PALETTE: 89, HOUR: 91, STRIKE: 69, WEATHER: 75, CLOUD: 76, RAIN: 77, WIND: 78 };
/** N1's fields on the open ground and its places (`v2/tools/import-eden`): an origin (the facts' id), an outline, a
 *  line, the tile size and the tiles. */
const ORIGIN = 1, OUTLINE = 11, LINE = 16, TILE_SIZE = 24, TILES = 25;
/** Where new Souls arrive, on the world's root (`replica::arrival::F_ARRIVAL`): a place's id, or `[]` for none. */
export const ARRIVAL = 92;
/** E6's kinds and each one's cloud, rain and wind (`sim::daylight`). */
export const KINDS = { clear: [10, 0, 10], cloudy: [75, 0, 20], rain: [90, 60, 30], wind: [30, 0, 70], fog: [60, 0, 5], storm: [100, 90, 80] };
/** Today's sky palettes (`tools/god-skill/lib/sky.mjs`), stored as `souls:<name>`. */
export const PALETTES = ['clear-day', 'golden-hour', 'dawn', 'sunset', 'dusk', 'twilight', 'night', 'midnight', 'mars-desert', 'lm-garden', 'eden-summer'];
const MINUTE_US = 60_000_000;

const no = (code, detail) => ({ ok: false, code, detail });

/** Every node record of the copy, from its roots down: `{ id, m }`, `m` the decoded record. */
function* records(copy) {
  const todo = Object.values(JSON.parse(copy.roots()));
  const seen = new Set();
  while (todo.length) {
    const hash = todo.pop();
    if (seen.has(hash)) continue;
    seen.add(hash);
    const bytes = copy.record(hash);
    if (!bytes) continue;
    const m = decode(bytes);
    yield { id: idText(m.get(1)), m };
    for (const c of m.get(10) ?? []) todo.push(Buffer.from(c).toString('hex'));
  }
}

const fieldsOf = (m) => (m.get(6) instanceof Map ? m.get(6) : new Map());

/** The world's own node (the one holding E6's calendar) and the open ground (the one holding tiles), from the copy. */
export function worldOf(copy) {
  let world = null, ground = null, root = null;
  const nodes = new Map();
  for (const r of records(copy)) {
    nodes.set(r.id, r.m);
    if (!root && !r.m.has(3)) root = r.id;
    const f = allFields(copy, r.m);
    if (!world && f.has(SKY.DAY_S)) world = { id: r.id, fields: f };
    if (!ground && f.has(TILES)) ground = { id: r.id, fields: f };
  }
  return { world, ground, nodes, root };
}

const level = (v, name) => {
  if (v === undefined) return undefined;
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 && x <= 1 ? Math.round(x * 100) : no('weather.level', `--${name} is 0 to 1, not ${v}`);
};

/** The sets a weather makes, at world time `now` (µs), on `world`; or a refusal. */
export function weatherOps(world, a, now) {
  if (!world) return no('weather.no-sky', 'this world\'s node has no sky');
  if (now === null || now === undefined) return no('weather.no-clock', 'the copy has no clock yet: run status until connected is true');
  const kind = a.kind === undefined ? String(world.fields.get(SKY.WEATHER) ?? 'souls:clear').replace(/^souls:/, '') : String(a.kind);
  if (!KINDS[kind]) return no('weather.kind-unknown', `--kind is one of ${Object.keys(KINDS).join(', ')}, not ${kind}`);
  const given = [level(a.clouds, 'clouds'), level(a.rain, 'rain'), level(a.wind, 'wind')];
  const bad = given.find((g) => g?.ok === false);
  if (bad) return bad;
  if (a.kind === undefined && given.every((g) => g === undefined)) return no('weather.nothing', 'give --kind, --clouds, --rain or --wind');
  const minutes = a.minutes === undefined ? 60 : Number(a.minutes);
  if (!(minutes >= 5 && minutes <= 360)) return no('weather.minutes', `--minutes is 5 to 360 world minutes, not ${a.minutes}`);
  const levels = KINDS[kind].map((l, i) => given[i] ?? l);
  const until = now + Math.round(minutes * MINUTE_US);
  const set = (field, value) => ({ op: 'set', node: world.id, field, value });
  return {
    ops: [set(SKY.WEATHER, `souls:${kind}`), set(SKY.CLOUD, levels[0]), set(SKY.RAIN, levels[1]), set(SKY.WIND, levels[2]), set(SKY.WEATHER_UNTIL, until)],
    says: `${kind}: clouds ${levels[0]}%, rain ${levels[1]}%, wind ${levels[2]}% for ${minutes} world minutes`,
  };
}

/** The set a sky palette makes; or a refusal. */
export function skyOps(world, a) {
  if (!world) return no('sky.no-sky', 'this world\'s node has no sky');
  if (a.sun !== undefined) return no('sky.sun-follows-time', 'the sun follows the world\'s own time, which never stops (parity row 97): set a palette only');
  const p = a.palette === undefined ? undefined : String(a.palette).replace(/^souls:/, '');
  if (!p) return no('sky.palette', `sky --palette <name>: ${PALETTES.join(', ')}`);
  if (!PALETTES.includes(p)) return no('sky.palette-unknown', `${p} is not a palette: ${PALETTES.join(', ')}`);
  return { ops: [{ op: 'set', node: world.id, field: SKY.PALETTE, value: `souls:${p}` }], says: `the sky's palette is ${p}` };
}

/** The set a staged hour makes (`replica::sky::F_SKY_HOUR`): µs after local midnight the page draws the sky at, or
 *  `souls:live` for the world's own time; or a refusal. Display only: nothing in the world reads it. */
export function hourOps(world, a) {
  if (!world) return no('time.no-sky', 'this world\'s node has no sky');
  if (a.speed !== undefined || a.pause !== undefined) return no('time.never-stops', 'world time never stops or changes speed: stage the hour shown with time <HH:MM>');
  const h = String(a.hour ?? '');
  if (h === 'live') return { ops: [{ op: 'set', node: world.id, field: SKY.HOUR, value: 'souls:live' }], says: 'the sky shows the world\'s own time' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) return no('time.form', `time <HH:MM | live>, not ${h || 'nothing'}`);
  const us = (Number(h.slice(0, 2)) * 60 + Number(h.slice(3))) * MINUTE_US;
  return { ops: [{ op: 'set', node: world.id, field: SKY.HOUR, value: us }], says: `the sky is shown at ${h}; the world's clock is unchanged` };
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

/** Where `at` names, in mm on the open ground: `x,z` metres, or a node's outline middle or spot. */
function pointOf(at, nodes) {
  const xz = /^(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)$/.exec(String(at ?? '').trim());
  if (xz) return [Math.round(Number(xz[1]) * 1000), Math.round(Number(xz[3]) * 1000)];
  const m = nodes.get(String(at ?? ''));
  if (!m) return null;
  const ring = fieldsOf(m).get(OUTLINE);
  if (Array.isArray(ring) && ring.length) {
    const sum = ring.reduce((s, p) => [s[0] + num(p[0]), s[1] + num(p[1])], [0, 0]);
    return [Math.round(sum[0] / ring.length), Math.round(sum[1] / ring.length)];
  }
  const pos = m.get(7) instanceof Map ? m.get(7).get(2) : null; // the pose's position, µm
  return Array.isArray(pos) ? [Math.round(num(pos[0]) / 1000), Math.round(num(pos[2]) / 1000)] : null;
}

/** Whether (x, z) mm is on one of the open ground's tiles. */
function onGround(ground, [x, z]) {
  if (!ground) return true;
  const size = num(ground.fields.get(TILE_SIZE)), tiles = ground.fields.get(TILES);
  if (!size || !Array.isArray(tiles)) return true;
  const tx = Math.floor(x / size), tz = Math.floor(z / size);
  return tiles.some((t) => num(t[0]) === tx && num(t[1]) === tz);
}

/** The set a lightning strike at `at` makes at world time `now`; or a refusal. */
export function strikeOps({ world, ground, nodes }, a, now) {
  if (!world) return no('strike.no-sky', 'this world\'s node has no sky');
  if (now === null || now === undefined) return no('strike.no-clock', 'the copy has no clock yet: run status until connected is true');
  const p = pointOf(a.at, nodes);
  if (!p) return no('strike.where', `strike <x,z in metres | an id describe lists>, not ${a.at ?? 'nothing'}`);
  if (!onGround(ground, p)) return no('strike.off-the-ground', `${p[0] / 1000}, ${p[1] / 1000} is off the world's ground`);
  return { ops: [{ op: 'set', node: world.id, field: SKY.STRIKE, value: [p[0], p[1], now] }], says: `lightning strikes ${p[0] / 1000}, ${p[1] / 1000}` };
}

/** The middle of the box round a place's outline (or line), mm, as the world takes it (`replica::arrival::middle`). */
function middleOf(m) {
  const f = fieldsOf(m), pts = f.get(OUTLINE) ?? f.get(LINE);
  if (!Array.isArray(pts) || !pts.length) return null;
  const xs = pts.map((p) => num(p[0])), zs = pts.map((p) => num(p[1]));
  return [Math.trunc((Math.min(...xs) + Math.max(...xs)) / 2), Math.trunc((Math.min(...zs) + Math.max(...zs)) / 2)];
}

/** Whether a node record is the open ground (`eden:ground`, a world's own `*:ground`): what places stand on. */
const isGround = (m) => /:ground$/.test(String(m?.get(2) ?? '').split('@')[0]);

/** The places Souls can arrive at (`replica::arrival`): the open ground's nodes with an outline or a line,
 *  `{ id, origin, at }` (`at` mm). */
export function placesOf({ nodes }) {
  const out = [];
  for (const [id, m] of nodes) {
    if (!m.has(3) || !isGround(nodes.get(idText(m.get(3))))) continue;
    const at = middleOf(m);
    if (!at) continue;
    const o = fieldsOf(m).get(ORIGIN);
    out.push({ id, origin: o instanceof Uint8Array ? Buffer.from(o).toString() : typeof o === 'string' ? o : null, at });
  }
  return out;
}

/** The set that names where new Souls arrive (#5006): a place of the world by its id or its facts id, or none with
 *  `clear`; or a refusal by name. Births ring round the place's middle from the next one; the world checks it too. */
export function arrivalOps(found, a) {
  if (!found.root) return no('arrival.no-world', 'the copy has no world yet: run status until connected is true');
  const set = (value) => [{ op: 'set', node: found.root, field: ARRIVAL, value }];
  if (a.clear) return { ops: set([]), says: 'new Souls arrive where the world\'s host put them: its arrival, else its entry' };
  const want = String(a.place ?? '').trim();
  const places = placesOf(found);
  const p = places.find((x) => x.id === want) ?? places.find((x) => x.origin === want);
  if (!p) {
    const some = places.slice(0, 8).map((x) => x.origin ?? x.id).join(', ');
    return no('arrival.unknown-place', `${want || 'nothing'} is not a place of this world (an area or a line on the open ground)${some ? `: ${some}${places.length > 8 ? ', ...' : ''}` : ''}`);
  }
  const [scope, counter] = p.id.split('-');
  const where = `${p.at[0] / 1000}, ${p.at[1] / 1000} m`;
  return { ops: set([{ hex: scope }, Number(counter)]), says: `new Souls arrive at ${p.origin ?? p.id} (${where}), from the next one born` };
}

/** The batch a world verb (`{ verb, ...args }`) makes on `copy` at world time `now`; or a refusal. */
export function worldOps(copy, w, now) {
  const found = worldOf(copy);
  if (w.verb === 'weather') return weatherOps(found.world, w, now);
  if (w.verb === 'sky') return skyOps(found.world, w);
  if (w.verb === 'strike') return strikeOps(found, w, now);
  if (w.verb === 'time') return hourOps(found.world, w);
  if (w.verb === 'arrival') return arrivalOps(found, w);
  return no('edit.batch', `weather, sky, strike, time or arrival, not ${w.verb}`);
}

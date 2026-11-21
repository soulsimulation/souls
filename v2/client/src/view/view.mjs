// `view` (0.131 parity C17, #3687): today's `eden.mjs view` on Engine v2. The Soul's first-person sight as text (what
// is ahead, left and right, near and far: `sight.mjs`, today's caption), `--alt-only` for the words alone, the picture
// from its own eyes (`shoot --eyes`'s), and `--map` (or `map`) a picture of the surroundings from overhead, north up.
//
// All of it is read here, from the site's own page in the headless browser `shoot` opens (G10: anonymous, the public
// stream only); no model turn and no server render. Words and picture come from the same drawn moment. Names are the
// copy's (`find`'s), asked of the Soul's daemon when one runs, else the page's own. With no browser, the answer is
// the daemon's brief and why.

import { extname, join, resolve } from 'node:path';
import { readSeat, soulsWithTokens } from '../home/home.mjs';
import { chooseSoul } from '../home/commands.mjs';
import { findPlaywright, globalNodeModules, pageOf, picture, settle, withWorld } from '../shoot/shoot.mjs';
import { computeSight } from './sight.mjs';

export const USAGE = 'view [--alt-only] [--out view.jpg] [--map] [--small] [--page <url>] [--of <Soul>]  |  map [--out map.jpg]';
/** How far around the eyes the page's things are gathered, m (today's landmarks reach 120 m). */
export const GATHER_M = 130;
/** The overhead map's eye height above the Soul, m. */
export const MAP_UP = 60;

const fail = (code, detail) => Object.assign(new Error(detail), { code });

/** The arguments. `map` is `view --map`. Throws the usage on anything it does not know. */
export function parseView(args, { map = false } = {}) {
  const o = { altOnly: false, out: null, map, small: false, page: null, of: null, soul: null };
  const need = (i) => { const v = args[i + 1]; if (v === undefined || v.startsWith('--')) throw fail('usage', `${args[i]} needs a value. ${USAGE}`); return v; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--alt-only' || a === '--alt') o.altOnly = true;
    else if (a === '--map') o.map = true;
    else if (a === '--small') o.small = true;
    else if (['--out', '--page', '--of', '--soul'].includes(a)) o[a.slice(2)] = need(i), i++;
    else throw fail('usage', `unknown ${a.startsWith('--') ? 'option' : 'word'} ${a}. ${USAGE}`);
  }
  if (o.map && o.altOnly) throw fail('usage', '--map is a picture; --alt-only gives words alone');
  o.out ??= o.altOnly ? null : o.map ? 'map.jpg' : 'view.jpg';
  if (o.out && !['.png', '.jpg', '.jpeg'].includes(extname(o.out).toLowerCase())) throw fail('usage', 'a view is written as .png or .jpg');
  o.size = o.map ? [768, 768] : o.small ? [640, 360] : [1280, 720];
  return o;
}

/**
 * Runs in the page (serialized: it uses nothing from this module). What the Soul `[grant, of]` names can see the
 * page draw now, for `computeSight`: its body, eyes and gaze (the camera `shoot --eyes` uses, which it leaves set),
 * the bodies, things and areas around, and the tall solids' footprints, world metres.
 */
export function gather([grant, of, reach]) {
  const v = globalThis.v2, w = v.world, t = v.director.t ?? null;
  const STRUCTURE = new Set(['souls:place', 'eden:world', 'eden:ground', 'eden:floor', 'eden:room', 'eden:window', 'eden:place', 'eden:doorway']);
  const plain = (k) => String(k).split('@')[0];
  const ap = (m, x, y, z) => { const e = m.elements; return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
  const at = (id) => {
    const n = w.nodes.get(id);
    if (!n) return null;
    const p = t === null ? null : w.tracks.get(id)?.at(t);
    return p ? ap(w.frame(n.parent), p[0] * 1e-6, p[1] * 1e-6, p[2] * 1e-6) : ap(w.frame(id), 0, 0, 0);
  };
  const roomOf = (id) => { for (let n = w.nodes.get(id), k = 0; n && k < 32; n = n.parent ? w.nodes.get(n.parent) : null, k++) if (plain(n.kind) === 'eden:room') return n.id; return null; };
  const spots = v.capture.where(), byId = new Map(spots.map((s) => [s.id, s]));
  let mine = null;
  if (of) mine = v.capture.aim(of, true)?.spot ?? null;
  else for (const n of w.nodes.values()) if (n.soul === grant) { mine = byId.get(n.id) ?? null; break; }
  if (!mine) return { code: of ? 'nothing-by-that-name' : 'body-not-drawn' };
  if (mine.role !== 'soul') return { code: 'eyes-are-a-souls', name: mine.name };
  const aimed = v.capture.aim(mine.id, true);
  if (!aimed) return { code: 'body-not-drawn' };
  const eye = aimed.aim.eye, near = (p) => p && Math.hypot(p[0] - eye[0], p[2] - eye[2]) <= reach;
  const room = roomOf(mine.id), floor = room ? w.nodes.get(room)?.parent : null, building = floor ? w.nodes.get(floor)?.parent ?? null : null;
  const name = (id) => byId.get(id)?.name ?? null;
  const me = { id: mine.id, name: mine.name, p: at(mine.id), room, roomName: room && name(room), building, buildingName: building && name(building), inside: room !== null };
  const bodies = [], things = [], areas = [], blocks = [];
  const feet = me.p[1];
  for (const n of w.nodes.values()) {
    const s = byId.get(n.id), kind = plain(n.kind);
    if (n.outline?.length >= 3 && kind !== 'eden:ground' && kind !== 'eden:world') {
      const outline = n.outline.map(([x, z]) => [x / 1000, z / 1000]);
      if (outline.some(([x, z]) => Math.hypot(x - eye[0], z - eye[2]) <= reach * 2)) areas.push({ id: n.id, name: s?.name ?? kind, outline });
    }
    if (!s || n.id === mine.id) continue;
    if (s.role === 'soul') { const p = at(n.id); if (near(p)) bodies.push({ id: n.id, name: s.name, p, room: roomOf(n.id) }); continue; }
    if (n.solids?.length && n.at === null && kind !== 'eden:ground' && kind !== 'eden:world') {
      const f = w.frame(n.id), sc = (n.scale ?? 1_000_000) / 1_000_000, mm = 1e-3 * sc;
      for (const [cx, cz, hx, hz, yaw, y0, y1] of n.solids) {
        const c = ap(f, cx * mm, 0, cz * mm);
        if (Math.hypot(c[0] - eye[0], c[2] - eye[2]) > reach) continue;
        const bottom = ap(f, cx * mm, y0 * mm, cz * mm)[1], top = ap(f, cx * mm, y1 * mm, cz * mm)[1];
        if (top - bottom < 1.5 || bottom > feet + 1.5 || top < feet + 1.4) continue;
        const a = (yaw / 1000) * (Math.PI / 180), co = Math.cos(a), si = Math.sin(a);
        const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, k]) => {
          const x = u * hx * mm, z = k * hz * mm, p = ap(f, cx * mm + x * co + z * si, 0, cz * mm - x * si + z * co);
          return [p[0], p[2]];
        });
        blocks.push({ owner: n.id, poly, room: roomOf(n.id) });
      }
    }
    if (STRUCTURE.has(kind)) continue;
    const p = at(n.id);
    if (near(p)) things.push({ id: n.id, name: s.name, p, room: roomOf(n.id), ...(s.role === 'place' ? { place: true } : {}) });
  }
  const d = t === null ? null : new Date(Math.floor(t / 1000));
  const clock = d && d.getUTCFullYear() > 1971 ? d.toISOString().slice(11, 16) : null;
  return { t, clock, me, eye, target: aimed.aim.target, bodies, things, areas, blocks };
}

/** The page's id `scope.n` as the copy's `scope-n`. */
export const copyId = (id) => String(id).replace(/\.(\d+)$/, '-$1');

/**
 * Names from the copy for the ids the words use (`find` by id, the copy's own names, as `find` and `look` give
 * them); an id the copy does not hold keeps the page's name. `ask` is the daemon call, or null.
 */
export async function copyNames(ids, ask) {
  if (!ask) return new Map();
  const out = new Map();
  await Promise.all([...new Set(ids)].map(async (id) => {
    const want = copyId(id);
    const a = await ask({ op: 'find', words: want, limit: 50 }).catch(() => null);
    const row = a?.found?.find((r) => r.id === want);
    if (row?.name) out.set(id, row.name);
  }));
  return out;
}

/** The sight from the gathered input, named from the copy: the words use the names `find` would answer. */
export async function sightOf(input, ask) {
  const first = computeSight(input);
  const ids = [...first.souls.map((s) => s.id), ...first.things.map((t) => t.id), input.me.room, input.me.building].filter(Boolean);
  const holding = (input.areas ?? []).map((a) => a.id);
  const names = await copyNames([...ids, ...holding.slice(0, 40)], ask);
  if (!names.size) return first;
  const named = (x) => (names.has(x.id) ? { ...x, name: names.get(x.id) } : x);
  const me = { ...input.me, roomName: names.get(input.me.room) ?? input.me.roomName, buildingName: names.get(input.me.building) ?? input.me.buildingName };
  return computeSight({ ...input, me, bodies: input.bodies.map(named), things: input.things.map(named), areas: (input.areas ?? []).map(named) });
}

/** The answer's fields from a sight: today's `view` shape (`alt`, `heading`, `sees`), with the things seen. */
export function answerOf(s, input) {
  return {
    alt: s.alt, at: input.t, clock: s.light.clock, heading: s.heading.compass, where: s.where,
    sees: s.souls.map((o) => `${o.name} · ${Math.round(o.distance)}m ${o.side}`),
    things: s.things.map((t) => ({ id: copyId(t.id), name: t.name, distance: t.distance, side: t.side, ...(t.count > 1 ? { count: t.count } : {}) })),
    untrusted: true,
  };
}

/** The Soul whose eyes: its grant (`soul-<scope>-<n>`, as the page's body-of link names it). */
export function grantOf(home, named) {
  const soul = chooseSoul(home, named, soulsWithTokens(home)), { grant } = readSeat(home, soul);
  return { soul, grant: `${grant.actor}-${grant.scope}-${grant.counter}` };
}

/** `souls.mjs view …` / `map …`. `ask` reaches the Soul's daemon (names, and the words with no browser). */
export async function runView(args, { home, env = {}, cwd = process.cwd(), ask = null, askOf = null, pw, map = false, who } = {}) {
  const o = parseView(args, { map });
  const page = pageOf(o, home, env);
  // The Soul whose eyes (`--soul`, else the home's one); with `--of`, another Soul's, named from this one's copy.
  const chosen = who ?? (o.of && !soulsWithTokens(home).length ? null : grantOf(home, o.soul));
  const soul = chosen?.soul ?? null, grant = o.of ? null : chosen.grant;
  ask ??= soul && askOf ? askOf(soul) : null;
  const roots = [env.SOULS_PLAYWRIGHT, cwd, home];
  const out = o.out ? resolve(cwd, o.out) : null;
  try {
    return await withWorld({ address: page, profile: join(home, 'cache', 'shoot-browser'), size: o.size, pw: pw !== undefined ? pw : findPlaywright([...roots, globalNodeModules()]) }, async (p) => {
      const input = await p.evaluate(gather, [grant, o.of, GATHER_M]);
      if (input.code) throw fail(input.code, input.code === 'body-not-drawn' ? 'the page does not draw this Soul\'s body (not in the world yet?)' : input.code === 'eyes-are-a-souls' ? `${input.name} is not a Soul` : `no Soul called "${o.of}" in the page`);
      const answer = { ok: true, ...(soul ? { soul } : {}), ...answerOf(await sightOf(input, ask), input) };
      if (!out) return answer;
      if (o.map) {
        const [x, y, z] = input.me.p;
        await p.evaluate(([x, y, z, up]) => {
          const v = globalThis.v2;
          v.director.free();
          v.cam.camera.position.set(x, y + up, z + up * 0.02);
          v.cam.controls.target.set(x, y, z);
          v.cam.camera.lookAt(x, y, z);
          v.cam.controls.update();
        }, [x, y, z, MAP_UP]);
      }
      await settle(p);
      if (!o.map) await p.evaluate((id) => globalThis.v2.capture.aim(id, true), input.me.id); // a body moves
      await picture(p, out);
      return { ...answer, saved: out, picture: o.map ? 'overhead, north up, this Soul in the middle' : 'first person, from this Soul\'s eyes' };
    });
  } catch (e) {
    if (e.code !== 'no-browser') throw e;
    const brief = ask ? await ask({ op: 'look' }).catch(() => null) : null;
    return { ok: true, alt: null, picture: null, why: e.message, words: brief ? { brief } : null, ...(brief ? {} : { note: 'no Soul daemon in this home to describe it' }) };
  }
}

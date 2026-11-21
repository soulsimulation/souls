#!/usr/bin/env node
// The creator's command (Engine v2 G7, #2796): a world's creator builds it live through the same resident daemon a
// Soul uses (R6), holding a creator-scope token. Each verb is one of G1's operations, sent as T10's edit intent (G1b)
// and answered once; `check` runs the same batch on the daemon's copy and asks the world nothing. Like souls.mjs, it
// loads no WASM and holds no copy: it passes its arguments to the daemon's socket and prints the answer, as JSON.
//
//   souls-god.mjs pair <world url> --creator <creator grant>   asks the world's directory for the creator's token
//   souls-god.mjs describe                       what is there (id, kind, parent) and what each kind admits
//   souls-god.mjs place <kind> --in <id> [--at x,y,z] [--slot n] [--field n=v ...]   a new thing; mm in the parent
//   souls-god.mjs move <id> --at x,y,z [--slot n]                                     to another spot, same parent
//   souls-god.mjs set <id> <field> <value>       one numbered field: an integer, true, false or a name
//   souls-god.mjs remove <id>                    it and everything in it
//   souls-god.mjs batch '<json list>'            several at once, all or none: [{"op":"place","name":1,...}, ...]; a
//                                                later op names an earlier place by its "name" number
//   souls-god.mjs check <any of the four, or batch> ...   the same, checked on the copy only; nothing is sent
//   souls-god.mjs build district [<id>]           the district plans, or one plan with each plot's status and the next
//                                                chapter to claim (#3701)
//   souls-god.mjs build district <id> --file plan.json   records a plan once (today's plan file: metres, radians)
//   souls-god.mjs build claim <part> --area x0,z0,x1,z1 | --district <id> [--plots a,b]   a build claim over an area
//                                                (mm on the ground), or over a plan's plots (its next chapter if none)
//   souls-god.mjs build claims | build release <claim>    the live claims (ids c:k<8 hex>); a claim released
//   souls-god.mjs own <id> <soul id|god|group:<name>|none> [--private|--public]   who owns a thing or a place (#3700)
//   souls-god.mjs access <id> private|public|none   a private thing is its owner's alone; what is inside takes its mark
//   souls-god.mjs zone <name> <use> --rect cx,cz,w,d | --circle cx,cz,r | --area '[[x,z],...]'   a land-use zone (mm)
//   souls-god.mjs zone-suggest <use> | layers | secret   what suits a use; zones and marks; secret places (off)
//   place, move, set, remove, batch, check ... --claim <claim>   sent under a build claim: it builds only inside it,
//                                                and others stay out of it until it is released
//   souls-god.mjs status | stop                  the daemon
//   souls-god.mjs welcome '<words>'              the words a Soul is shown when it arrives ('' clears them)
//   souls-god.mjs visitors                       the world's welcome and its most recent visitors, newest first
//                                                these two ask the world's directory, with the creator's token
//   any of them [--creator <c_id>]               which creator, when the home holds more than one
//
// A refusal prints its code, the operation that failed (`op`, its place in the batch) and a fix. The home is
// SOULS_HOME, else the nearest .souls; the daemon's library is SOULS_REPLICA_PKG. The token never leaves the daemon.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, readSeat, soulsWithTokens } from '../home/home.mjs';
import { worldOf } from '../cli/souls.mjs';

export const VERBS = ['pair', 'describe', 'place', 'move', 'set', 'remove', 'batch', 'check', 'build', 'own', 'access', 'zone', 'zone-suggest', 'layers', 'secret', 'status', 'stop', 'welcome', 'visitors'];
const PAIR = join(dirname(fileURLToPath(import.meta.url)), '../pair/pair.mjs');

/** What to do about each refusal, by its name: the world's (G1, G2) and the command's own. */
export const FIX = {
  'edit.not-the-creator': 'this token is not the world\'s creator\'s: pair with --creator <its creator grant>',
  'edit.kind-unknown': 'use a kind describe lists under kinds',
  'edit.child-not-admitted': 'put it in something whose kind admits it: describe shows each kind\'s admits',
  'edit.node-missing': 'that id is not there now: describe again and use an id it lists',
  'edit.name-unknown': 'a later op names an earlier place by that place\'s "name" number',
  'edit.name-twice': 'give each place in a batch its own "name" number',
  'edit.root': 'the world\'s root is never moved or removed',
  'edit.stale': 'something you changed was changed by someone else first: describe, then send again',
  'edit.too-many-operations': 'split the batch: at most 256 operations',
  'edit.too-many-nodes': 'remove less at once',
  'edit.batch': 'see the usage: souls-god.mjs with no arguments',
  'edit.unanswered': 'the world did not answer within 10 s: describe to see whether it was done',
  'edit.no-copy': 'the daemon has no copy yet: run status until connected is true',
  'not-a-creator': 'pair with --creator <the world\'s creator grant>',
  'edit.claimed': 'that is inside a live claim: send it with --claim <that claim>, or build release <claim>',
  'edit.outside-claim': 'under a claim, edit only inside its area: build claims shows it; the world\'s own fields are the lead\'s',
  'edit.claim-unknown': 'build claims lists the live claims',
  'edit.claim-malformed': 'claims are at most 8 and never overlap: build claims shows them',
  'edit.district-malformed': 'fix the named plan field and record the plan again',
  'district.unknown': 'build district lists the plans; record one with build district <id> --file plan.json',
  'district.exists': 'a plan is recorded once: pick a new id, or claim its chapters (build district <id>)',
  'district.plot': 'build district <id> lists its plots',
  'claim.unknown': 'build claims lists the live claims',
  'edit.owner-malformed': 'own <id> <soul id|god|group:<name>|none>; access <id> private|public|none',
  'edit.zone-malformed': `zone <name> <${'residential|commercial|park|farm|civic|industrial|wild'}> with an outline of 3 to 64 points`,
  'zone.unknown': 'layers lists the zones',
  'secret.off': 'secret places are off, as on soul.game today: every place is on every Soul\'s map',
  'which-creator': 'name one with --creator',
  'not-the-creator': 'only the world\'s creator: pair with --creator <its creator grant>',
  'welcome-too-long': 'at most 500 characters',
  'welcome-not-text': 'plain words and line breaks only',
  'token-refused': 'pair again with --creator <the world\'s creator grant>',
};

const usage = (detail) => Object.assign(new Error(detail), { code: 'usage' });
const takeOpt = (args, name) => { const k = args.indexOf(name); if (k < 0) return undefined; const v = args[k + 1]; args.splice(k, 2); return v; };
const takeAll = (args, name) => { const out = []; for (let v; (v = takeOpt(args, name)) !== undefined;) out.push(v); return out; };
const xyz = (t) => {
  const p = String(t).split(',').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) throw usage(`--at x,y,z in mm, not ${t}`);
  return p;
};
/** A field's value as written: an integer, true or false, else a name. */
const valueOf = (t) => (/^-?\d+$/.test(t) ? Number(t) : t === 'true' ? true : t === 'false' ? false : t);
const node = (t) => (/^\d+$/.test(String(t)) ? Number(t) : String(t));

/** The batch a verb's words make. */
export function opsOf(verb, words) {
  const args = [...words];
  if (verb === 'batch') {
    try { return JSON.parse(args.join(' ')); } catch { throw usage('batch takes a JSON list of operations'); }
  }
  if (verb === 'place') {
    const into = takeOpt(args, '--in'), at = takeOpt(args, '--at'), slot = takeOpt(args, '--slot');
    const fields = Object.fromEntries(takeAll(args, '--field').map((f) => { const [n, v] = f.split('='); return [n, valueOf(v)]; }));
    if (!args[0] || into === undefined) throw usage('place <kind> --in <id> [--at x,y,z] [--slot n] [--field n=v]');
    return [{ op: 'place', name: 1, kind: args[0], in: node(into), ...(at ? { at: xyz(at) } : {}), ...(slot !== undefined ? { slot: Number(slot) } : {}), ...(Object.keys(fields).length ? { fields } : {}) }];
  }
  if (verb === 'move') {
    const at = takeOpt(args, '--at'), slot = takeOpt(args, '--slot');
    if (!args[0] || !at) throw usage('move <id> --at x,y,z [--slot n]');
    return [{ op: 'move', node: node(args[0]), at: xyz(at), ...(slot !== undefined ? { slot: Number(slot) } : {}) }];
  }
  if (verb === 'set') {
    if (args.length !== 3 || !/^\d+$/.test(args[1])) throw usage('set <id> <field number> <value>');
    return [{ op: 'set', node: node(args[0]), field: Number(args[1]), value: valueOf(args[2]) }];
  }
  if (verb === 'remove') {
    if (!args[0]) throw usage('remove <id>');
    return [{ op: 'remove', node: node(args[0]) }];
  }
  throw usage(`one of ${VERBS.join(', ')}`);
}

/** The daemon request the arguments make, and the creator named. */
export function requestOf(argv) {
  const args = [...argv];
  const creator = takeOpt(args, '--creator');
  const claim = takeOpt(args, '--claim');
  const under = claim === undefined ? {} : { claim: claimId(claim) };
  const [verb = 'status', ...rest] = args;
  if (!VERBS.includes(verb)) throw Object.assign(new Error(`one of ${VERBS.join(', ')}`), { code: 'unknown-command' });
  if (verb === 'pair') return { pair: rest[0], creator };
  if (verb === 'welcome') {
    if (rest.length > 1) throw usage("welcome '<words>': quote the words as one argument");
    return { directory: '/v1/worlds/welcome', body: { welcome: rest[0] ?? '' }, creator };
  }
  if (verb === 'visitors') return { directory: '/v1/worlds/visitors', body: {}, creator };
  if (verb === 'status' || verb === 'stop' || verb === 'describe') return { req: { op: verb }, creator };
  if (verb === 'build') return { build: buildOf(rest), creator };
  if (LAYER_VERBS.includes(verb)) return { layer: layerOf(verb, rest), creator };
  if (verb === 'check') return { req: { op: 'check', ops: opsOf(rest[0], rest.slice(1)), ...under }, creator };
  return { req: { op: 'edit', ops: opsOf(verb, rest), ...under }, creator };
}

// ---------------------------------------------------------------- #3701: district plans and build claims
// Both are fields of the zone's root (replica `edit::claims`): plans in 140, live claims in 141, whole mm on the ground
// and millidegrees. Every text there is a `namespace:name` name, so ids are kept with a prefix (`d:`, `p:`, `c:`) and
// shown without it. Recording a plan or a claim is an ordinary edit of that field, so undo takes it back.
export const F_DISTRICTS = 140, F_CLAIMS = 141;
const SLUG = /^[a-z][a-z0-9_-]*$/;
/** A name an effect may carry from what a creator writes: lowercase, other characters as `-`, a letter first. */
export function slug(t) {
  let s = String(t ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(s)) s = `x${s}`;
  return s.slice(0, 56);
}
const named = (ns, t) => `${ns}:${slug(t)}`;
const bare = (t) => String(t).replace(/^[a-z][a-z0-9-]*:/, '');
/** A claim id as written (`c:1a2b3c4d` or `1a2b3c4d`) as the world holds it. */
export const claimId = (t) => (String(t).startsWith('c:') ? String(t) : `c:${String(t)}`);
const mmOf = (m) => Math.round(Number(m) * 1000);
const mdegOf = (rad) => Math.round(((Number(rad ?? 0) * 180) / Math.PI) * 1000);

/** The build request the words make: `{ act: 'districts' | 'district' | 'record' | 'claim' | 'claims' | 'release', ... }`. */
export function buildOf(words) {
  const args = [...words];
  const file = takeOpt(args, '--file'), area = takeOpt(args, '--area'), district = takeOpt(args, '--district'), plots = takeOpt(args, '--plots');
  const [what, id] = args;
  if (what === 'district') {
    if (id === undefined) return { act: 'districts' };
    return file === undefined ? { act: 'district', id } : { act: 'record', id, file };
  }
  if (what === 'claims') return { act: 'claims' };
  if (what === 'release') { if (!id) throw usage('build release <claim>'); return { act: 'release', claim: claimId(id) }; }
  if (what === 'claim') {
    if (!id || (area === undefined) === (district === undefined)) throw usage('build claim <part> --area x0,z0,x1,z1 | --district <id> [--plots a,b]');
    if (area !== undefined) {
      const a = area.split(',').map(Number);
      if (a.length !== 4 || a.some((n) => !Number.isInteger(n)) || a[0] >= a[2] || a[1] >= a[3]) throw usage(`--area x0,z0,x1,z1 in whole mm, x0 < x1 and z0 < z1, not ${area}`);
      return { act: 'claim', part: id, area: a };
    }
    return { act: 'claim', part: id, district, ...(plots ? { plots: plots.split(',') } : {}) };
  }
  throw usage('build district [<id>] [--file plan.json] | build claim <part> ... | build claims | build release <claim>');
}

/** Today's plan file (metres, radians: `apps/server/src/god/districts.ts`) as the world's plan row. */
export function planRow(id, plan) {
  if (!plan || !Array.isArray(plan.plots) || plan.plots.length === 0) throw Object.assign(new Error('a plan has plots: [{id, at: [x, z], size: [w, d]}]'), { code: 'district.plan' });
  const plot = (p) => {
    if (!Array.isArray(p.at) || !Array.isArray(p.size)) throw Object.assign(new Error(`plot ${p.id}: at [x, z] and size [w, d] in metres`), { code: 'district.plan' });
    return [named('p', p.id), mmOf(p.at[0]), mmOf(p.at[1]), mmOf(p.size[0]), mmOf(p.size[1]), mdegOf(p.yaw), ...(p.use ? [named('use', p.use)] : [])];
  };
  const road = (r) => [named('road', r.id), mmOf(r.width), (r.path ?? []).flatMap(([x, z]) => [mmOf(x), mmOf(z)])];
  return [named('d', id), named('title', plan.title ?? id), plan.plots.map(plot), (plan.roads ?? []).map(road), (plan.chapters ?? []).map((c) => c.map((p) => named('p', p)))];
}

const rowsIn = (v) => (Array.isArray(v) ? v : []);
/** The live claims a root field holds, as a creator reads them. */
export const claimsIn = (v) => rowsIn(v).map(([id, part, x0, z0, x1, z1]) => ({ id, part: bare(part), area: [x0, z0, x1, z1].map(Number) }));
/** A plot's corners on the ground, mm. */
function corners([, x, z, w, d, yaw]) {
  const a = (Number(yaw) / 1000) * (Math.PI / 180), c = Math.cos(a), s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => { const u = (i * w) / 2, v = (j * d) / 2; return [x + u * c + v * s, z - u * s + v * c]; });
}
/** The rectangle on the ground that holds the plots, whole mm. */
export function areaOf(plots) {
  const pts = plots.flatMap(corners), xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  // A turn's sine and cosine are not exact: a hair past a whole mm is that mm.
  const lo = (v) => Math.floor(v + 1e-6), hi = (v) => Math.ceil(v - 1e-6);
  return [lo(Math.min(...xs)), lo(Math.min(...zs)), hi(Math.max(...xs)), hi(Math.max(...zs))];
}
const inside = ([x0, z0, x1, z1], x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
/** One plan as a creator reads it: plots with their status (claimed by a live claim over its centre, else planned) and
 * the next chapter to claim. */
export function districtView(row, claims) {
  const [id, title, plots, roads, chapters] = row;
  const claimOf = (p) => claims.find((c) => inside(c.area, Number(p[1]), Number(p[2])));
  const view = plots.map((p) => ({ id: bare(p[0]), at: [p[1], p[2]], size: [p[3], p[4]], yaw: p[5], ...(p[6] ? { use: bare(p[6]) } : {}), status: claimOf(p) ? 'claimed' : 'planned', ...(claimOf(p) ? { claim: claimOf(p).id } : {}) }));
  const groups = chapters.length ? chapters.map((c) => c.map(bare)) : view.map((p) => [p.id]);
  const open = groups.find((g) => g.every((p) => view.find((v) => v.id === p)?.status === 'planned'));
  return {
    id: bare(id), title: bare(title), plots: view, roads: roads.map(([r, w, path]) => ({ id: bare(r), width: w, path: rowsIn(path).reduce((o, n, i) => (i % 2 ? (o.at(-1).push(n), o) : [...o, [n]]), []) })),
    counts: { plots: view.length, claimed: view.filter((p) => p.status === 'claimed').length, planned: view.filter((p) => p.status === 'planned').length },
    next: open ? { plots: open, then: `build claim <part> --district ${bare(id)} --plots ${open.join(',')}` } : null,
  };
}

const fail = (code, detail) => ({ ok: false, code, detail });
/** Runs a build request through the daemon's `fields` and `edit`; the answer to print. */
export async function runBuild(b, ask) {
  const root = await ask({ op: 'fields' });
  if (root.ok === false) return root;
  const plans = rowsIn(root.fields[F_DISTRICTS]), claims = claimsIn(root.fields[F_CLAIMS]);
  const set = (field, value) => ask({ op: 'edit', ops: [{ op: 'set', node: root.id, field, value }] });
  const find = (id) => plans.find((r) => r[0] === named('d', id));
  if (b.act === 'districts') return { ok: true, districts: plans.map((r) => { const v = districtView(r, claims); return { id: v.id, title: v.title, counts: v.counts }; }) };
  if (b.act === 'claims') return { ok: true, claims };
  if (b.act === 'district') { const r = find(b.id); return r ? { ok: true, district: districtView(r, claims) } : fail('district.unknown', `no plan ${b.id}`); }
  if (b.act === 'record') {
    if (find(b.id)) return fail('district.exists', `plan ${b.id} is recorded`);
    const row = planRow(b.id, JSON.parse(readFileSync(b.file, 'utf8')));
    const out = await set(F_DISTRICTS, [...plans, row]);
    return out.ok === false ? out : { ...out, district: districtView(row, claims) };
  }
  if (b.act === 'release') {
    if (!claims.some((c) => c.id === b.claim)) return fail('claim.unknown', `no live claim ${b.claim}`);
    return set(F_CLAIMS, rowsIn(root.fields[F_CLAIMS]).filter((r) => r[0] !== b.claim));
  }
  let area = b.area;
  if (b.district !== undefined) {
    const r = find(b.district);
    if (!r) return fail('district.unknown', `no plan ${b.district}`);
    const v = districtView(r, claims), ids = b.plots ?? v.next?.plots;
    if (!ids) return fail('district.plot', `every plot of ${b.district} is claimed`);
    const rows = ids.map((p) => r[2].find((x) => x[0] === named('p', p)));
    if (rows.some((x) => !x)) return fail('district.plot', `${b.district} has no plot ${ids[rows.findIndex((x) => !x)]}`);
    area = areaOf(rows);
  }
  const id = `c:k${randomBytes(4).toString('hex')}`; // a name part starts with a letter
  const out = await set(F_CLAIMS, [...rowsIn(root.fields[F_CLAIMS]), [id, named('part', b.part), ...area]]);
  return out.ok === false ? out : { ...out, claim: { id, part: slug(b.part), area }, then: `send its edits with --claim ${id}` };
}

/**
 * Asks the world's directory (#3702) as the creator: the seat's world and token from the home, sent as a Bearer to
 * the directory the pairing kept. The token is never printed.
 */
async function askDirectory(home, creator, path, body) {
  const seat = readSeat(home, creator);
  let url;
  try { url = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).worlds?.[seat.world]?.url; } catch { /* below */ }
  if (typeof url !== 'string') throw Object.assign(new Error(`no directory kept for ${seat.world}; pair again`), { code: 'no-directory' });
  const r = await fetch(new URL(path, url), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${seat.token}` },
    body: JSON.stringify({ world: seat.world, ...body }), signal: AbortSignal.timeout(15_000),
  });
  const got = await r.json().catch(() => ({}));
  return got.refused ? { ok: false, code: got.refused } : { ok: true, ...got };
}

/** An answer with its fix, when it is a refusal the table knows. */
export const withFix = (out) => (out?.ok === false && FIX[out.code] ? { ...out, fix: FIX[out.code] } : out);

/** W2's pairing for a creator, detached as souls.mjs's is: its first line (the link and code, or the refusal). */
async function pairing(home, url, grant, { within = 15_000 } = {}) {
  if (!/^creator-[0-9a-f]{32}-\d+$/.test(grant ?? '')) throw Object.assign(new Error('pair <world url> --creator creator-<32 hex>-<n>'), { code: 'not-a-creator' });
  const { directory, world, gateway } = worldOf(url);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = join(home, 'pairing.log');
  writeFileSync(log, '', { mode: 0o600 });
  const out = openSync(log, 'a');
  spawn(process.execPath, [PAIR, '--directory', directory, '--world', world, '--gateway', gateway, '--label', 'souls-god.mjs', '--creator', grant], {
    detached: true, stdio: ['ignore', out, out], env: { PATH: process.env.PATH ?? '', SOULS_HOME: home },
  }).unref();
  for (const until = Date.now() + within; Date.now() < until;) {
    const first = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('{'));
    if (first) return { ...JSON.parse(first), then: 'describe, once the world\'s owner has approved' };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Object.assign(new Error(`no answer from ${directory}`), { code: 'directory-not-answering' });
}


// ---------------------------------------------------------------- #3700: ownership, access and land-use zones
// Today's `own`, `access`, `zone`, `zone-suggest`, `layers` and `secret` (tools/god-skill/lib/layers.mjs). Owner and
// access are two fields of the thing (replica `who_may::F_OWNER`, `F_ACCESS`); zones are a root field (92). Each is an
// ordinary edit, so undo takes it back. Secret places are off on soul.game today (#1262), so `secret` says so.
export const F_OWNER = 97, F_ACCESS = 98, F_ZONES = 92;
export const LAYER_VERBS = ['own', 'access', 'zone', 'zone-suggest', 'layers', 'secret'];
export const USES = ['residential', 'commercial', 'park', 'farm', 'civic', 'industrial', 'wild'];
/** Today's catalogue categories for each use (apps/server/src/god/layers.ts ZONE_SUGGEST). */
export const ZONE_SUGGEST = {
  residential: ['building.residential', 'furniture.seat', 'vegetation.shrub', 'vegetation.flower', 'utility.lighting', 'object.street'],
  commercial: ['building.commercial', 'public.square', 'object.street', 'object.sign', 'furniture.seat', 'utility.lighting', 'object.food'],
  park: ['public.park', 'vegetation.tree', 'vegetation.flower', 'water.feature', 'public.play', 'furniture.seat', 'utility.lighting'],
  farm: ['building.agricultural', 'vegetation.crop', 'living.farm', 'object.tool', 'object.container'],
  civic: ['building.civic', 'public.square', 'public.monument', 'public.venue', 'object.sign', 'water.feature'],
  industrial: ['building.industrial', 'utility.power', 'utility.waste', 'vehicle.road', 'layer.construction', 'object.container'],
  wild: ['vegetation.tree', 'terrain.landform', 'terrain.rock', 'water.body', 'living.wild', 'living.bird'],
};
const ID_TEXT = /^[0-9a-f]{32}-\d+$/;
/** An owner as written: a Soul's id, god, group:<name> or none, as the field holds it. */
export function ownerValue(t) {
  const v = String(t ?? '');
  if (v === 'none') return 0;
  if (v === 'god') return 'owner:god';
  if (/^group:[a-z][a-z0-9_-]*$/.test(v)) return v;
  if (ID_TEXT.test(v.replace(/^soul:/, ''))) return v.replace(/^soul:/, '');
  throw usage(`own <id> <soul id|god|group:<name>|none>, not ${v}`);
}
const ACCESS = { none: 0, public: 1, private: 2 };
/** A zone's outline in whole mm, as today's --rect, --circle and --area give it (here in mm). */
export function outlineOf({ rect, circle, area }) {
  const nums = (t, n, what) => { const a = String(t).split(',').map(Number); if (a.length < n || a.slice(0, n).some((x) => !Number.isFinite(x))) throw usage(`${what}, in mm`); return a; };
  let pts;
  if (rect !== undefined) { const [cx, cz, w, d] = nums(rect, 4, '--rect cx,cz,w,d'); pts = [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]]; }
  else if (circle !== undefined) { const [cx, cz, r] = nums(circle, 3, '--circle cx,cz,r'); pts = Array.from({ length: 12 }, (_, k) => [cx + Math.sin((k / 12) * 2 * Math.PI) * r, cz + Math.cos((k / 12) * 2 * Math.PI) * r]); }
  else if (area !== undefined) { try { pts = JSON.parse(area); } catch { throw usage("--area '[[x,z],...]' in mm"); } }
  else throw usage('zone <name> <use> --rect cx,cz,w,d | --circle cx,cz,r | --area \'[[x,z],...]\' (mm)');
  if (!Array.isArray(pts) || pts.length < 3 || pts.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((n) => !Number.isFinite(Number(n))))) throw usage('a zone outline is at least three [x, z] points');
  return pts.flatMap(([x, z]) => [Math.round(Number(x)), Math.round(Number(z))]);
}

/** The request a layer verb's words make. */
export function layerOf(verb, words) {
  const args = [...words];
  if (verb === 'own') {
    const priv = args.indexOf('--private'), pub = args.indexOf('--public');
    for (const k of [priv, pub].filter((k) => k >= 0).sort((a, b) => b - a)) args.splice(k, 1);
    if (args.length !== 2) throw usage('own <id> <soul id|god|group:<name>|none> [--private|--public]');
    return { act: 'own', node: args[0], owner: ownerValue(args[1]), ...(priv >= 0 ? { access: 2 } : pub >= 0 ? { access: 1 } : {}) };
  }
  if (verb === 'access') {
    if (args.length !== 2 || !(args[1] in ACCESS)) throw usage('access <id> private|public|none');
    return { act: 'access', node: args[0], access: ACCESS[args[1]] };
  }
  if (verb === 'zone') {
    const rect = takeOpt(args, '--rect'), circle = takeOpt(args, '--circle'), area = takeOpt(args, '--area');
    const [name, use] = args;
    if (!name || !USES.includes(use)) throw usage(`zone <name> <${USES.join('|')}> --rect cx,cz,w,d | --circle cx,cz,r | --area '[[x,z],...]' (mm); zone <name> none removes it`);
    return { act: 'zone', name: slug(name), use, outline: outlineOf({ rect, circle, area }) };
  }
  if (verb === 'zone-suggest') {
    if (!USES.includes(args[0])) throw usage(`zone-suggest <${USES.join('|')}>`);
    return { act: 'zone-suggest', use: args[0] };
  }
  return { act: verb };
}

/** The zones a root field holds, as a creator reads them. */
export const zonesIn = (v) => (Array.isArray(v) ? v : []).map(([n, u, pts]) => ({ name: bare(n), use: bare(u), outline: (pts ?? []).reduce((o, x, i) => (i % 2 ? (o.at(-1).push(x), o) : [...o, [x]]), []) }));

/** Runs a layer request through the daemon; the answer to print. */
export async function runLayer(l, ask) {
  if (l.act === 'secret') return { ok: false, code: 'secret.off', detail: 'secret places are off (#1262, decided 10 Nov 2026): every place is on every Soul\'s map', secrets: [] };
  if (l.act === 'zone-suggest') return { ok: true, use: l.use, categories: ZONE_SUGGEST[l.use] };
  const edit = (ops) => ask({ op: 'edit', ops });
  if (l.act === 'own') return edit([{ op: 'set', node: l.node, field: F_OWNER, value: l.owner }, ...(l.access !== undefined ? [{ op: 'set', node: l.node, field: F_ACCESS, value: l.access }] : [])]);
  if (l.act === 'access') return edit([{ op: 'set', node: l.node, field: F_ACCESS, value: l.access }]);
  const root = await ask({ op: 'fields' });
  if (root.ok === false) return root;
  const zones = Array.isArray(root.fields[F_ZONES]) ? root.fields[F_ZONES] : [];
  if (l.act === 'zone') {
    const row = [`zone:${l.name}`, `use:${l.use}`, l.outline];
    const out = await edit([{ op: 'set', node: root.id, field: F_ZONES, value: [...zones.filter((z) => z[0] !== row[0]), row] }]);
    return out.ok === false ? out : { ...out, zone: { name: l.name, use: l.use }, suits: ZONE_SUGGEST[l.use] };
  }
  // layers: the zones, and every marked thing (describe carries each node's marks).
  const d = await ask({ op: 'describe' });
  if (d.ok === false) return d;
  const words = { 0: 'none', 1: 'public', 2: 'private' };
  const marked = d.nodes.filter((n) => n.marks).map((n) => ({ id: n.id, kind: n.kind, ...(n.marks.owner !== undefined ? { owner: n.marks.owner } : {}), ...(n.marks.access !== undefined ? { access: words[n.marks.access] ?? n.marks.access } : {}) }));
  return { ok: true, zones: zonesIn(zones), marked, secrets: 'off, as today' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  try {
    const asked = requestOf(process.argv.slice(2));
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
    if (asked.pair !== undefined) { out(await pairing(home, asked.pair, asked.creator)); process.exit(0); }
    const creators = soulsWithTokens(home).filter((id) => id.startsWith('c_'));
    const creator = asked.creator ?? (creators.length === 1 ? creators[0] : undefined);
    if (!creator) throw Object.assign(new Error(`creators here: ${creators.join(', ') || 'none; pair first'}`), { code: 'which-creator' });
    if (asked.directory) {
      const said = await askDirectory(home, creator, asked.directory, asked.body);
      out(withFix(said));
      if (said.ok === false) process.exitCode = 1;
      process.exit();
    }
    const ask = (req) => call(home, creator, req, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: 15_000 });
    const answer = asked.build ? await runBuild(asked.build, ask) : asked.layer ? await runLayer(asked.layer, ask) : await ask(asked.req);
    out(withFix(answer));
    if (answer.ok === false) process.exitCode = 1;
  } catch (e) {
    out(withFix({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }));
    process.exitCode = 1;
  }
}

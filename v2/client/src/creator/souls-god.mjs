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
//   souls-god.mjs weather [--kind clear|cloudy|rain|wind|fog|storm] [--clouds 0..1] [--rain 0..1] [--wind 0..1]
//                         [--minutes 5..360]       the world's weather until then; E6's own weather resumes after
//   souls-god.mjs sky --palette <name>           the sky's palette (today's names: clear-day, dusk, mars-desert, ...)
//   souls-god.mjs strike <x,z | id>              lightning at a point (metres on the open ground) or on a place
//   souls-god.mjs land <raise|lower|flatten|knoll|hill|mountain|plateau|terrace|valley|ditch|cliff|pond|lake> [flags]
//   souls-god.mjs land water <id> --level m | --by m      the land and its water, as today's `land` (terrain/land.mjs):
//                                                one edit; what rests on changed ground moves with it, and a Soul
//                                                standing there refuses it (edit.terrain-under-soul)
//   souls-god.mjs check <any of these, or batch> ...   the same, checked on the copy only; nothing is sent
//   place <kind> --in <id> --beside <id> [--dir n|ne|e|se|s|sw|w|nw] [--dist mm]   beside another (default e, 1000)
//   place <kind> --on <id>                       in or on another: its first free slot for a thing, if it has one
//   place|move ... --facing <id|n|e|s|w>         turned to face another, or a compass point
//   any edit verb --build <name> --step <name>  a build's step (#3694): one batch the world keeps under that name
//   souls-god.mjs undo [--build <name>] | redo   the newest edit undone (a whole build, step by step), or redone
//   souls-god.mjs build district [<id>]           the district plans, or one plan with each plot's status and the next
//                                                chapter to claim (#3701)
//   souls-god.mjs build district <id> --file plan.json   records a plan once (today's plan file: metres, radians)
//   souls-god.mjs build claim <part> --area x0,z0,x1,z1 | --district <id> [--plots a,b]   a build claim over an area
//                                                (mm on the ground), or over a plan's plots (its next chapter if none)
//   souls-god.mjs build claims | build release <claim>    the live claims (ids c:k<8 hex>); a claim released
//   place, move, set, remove, batch, check ... --claim <claim>   sent under a build claim: it builds only inside it,
//                                                and others stay out of it until it is released
//   souls-god.mjs build claim ... --helper [--ttl <minutes>]   the claim with a helper (#3727): a scoped token for a
//                                                sub-agent, kept in a home of its own (SOULS_HOME=<that folder>);
//                                                it builds only under that claim, and lapses after --ttl (default 120)
//   souls-god.mjs build rewind <build> --to <step> [--dry]   undoes every edit of the build after that step, newest
//                                                first, while they are this daemon's newest (today's build rewind)
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

export const VERBS = [
  'batch',
  'build',
  'check',
  'describe',
  'land',
  'move',
  'pair',
  'place',
  'redo',
  'remove',
  'set',
  'sky',
  'status',
  'stop',
  'strike',
  'undo',
  'visitors',
  'weather',
  'welcome',
];
/** The world's verbs (#3695): the daemon makes their sets on the world node from its copy (`world.mjs`). */
export const WORLD_VERBS = ['weather', 'sky', 'strike', 'land'];
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
  'edit.unanswered': 'the world did not answer in time (10 s, a land edit 120 s): describe to see whether it was done',
  'undo.nothing': 'there is no edit left to undo',
  'undo.nothing-to-redo': 'redo follows an undo; a new edit clears what could be redone',
  'undo.conflict': 'something the undo would change was changed since: describe, then put it back by hand',
  'undo.no-inverse': 'that edit cannot be undone (it added a field or moved a thing in motion): change it back by hand',
  'undo.not-the-build': 'undo --build undoes only while the newest edit is one of that build\'s steps: undo the others first',
  'edit.would-bury': 'a Soul stands there now: wait until it has moved, or choose another place',
  'edit.would-cut-off': 'that would shut a Soul in: leave it a way out, or wait until it has moved',
  'edit.in-use': 'a Soul is using that thing: wait until it is done',
  'relation-unknown': 'describe, and name an id it lists with an `at`',
  'edit.no-copy': 'the daemon has no copy yet: run status until connected is true',
  'edit.weather-level': 'levels are 0 to 1',
  'edit.weather-ended': 'give --minutes from 5 to 360',
  'edit.weather-partial': 'use the weather verb: it sets kind, clouds, rain, wind and end together',
  'edit.weather-no-sky': 'this world has no sky to set',
  'weather.kind-unknown': 'use clear, cloudy, rain, wind, fog or storm',
  'weather.level': '--clouds, --rain and --wind are 0 to 1',
  'weather.minutes': '--minutes is 5 to 360 world minutes',
  'weather.nothing': 'give --kind, --clouds, --rain or --wind',
  'sky.palette-unknown': 'run sky with no palette for the list',
  'sky.sun-follows-time': 'leave out --sun: the sun follows world time',
  'strike.where': 'strike x,z in metres, or an id describe lists',
  'edit.terrain-under-soul': 'a Soul stands where the ground would change: shape the land elsewhere, or when it has moved',
  'edit.terrain-under-building': 'a building stands where the ground would change: shape the land clear of it',
  'edit.terrain-unsettled': 'a thing resting there was not moved with the ground: describe again and send the land verb again',
  'land.flag': 'see the usage: souls-god.mjs with no arguments',
  'land.too-many-things': 'shape a smaller area, or one with fewer things on it',
  'land.no-water': 'name a pond, lake or river\'s id from describe',
  'land.nothing': 'shape the land on the world\'s ground',
  'land.smooth': 'use flatten',
  'land.unavailable': 'run souls-god from a checkout with packages/ground and zod installed',
  'strike.off-the-ground': 'strike somewhere on the world\'s ground',
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
export function opsOf(verb, words, { related = false } = {}) {
  const args = [...words];
  if (verb === 'batch') {
    try { return JSON.parse(args.join(' ')); } catch { throw usage('batch takes a JSON list of operations'); }
  }
  if (verb === 'place') {
    const on = takeOpt(args, '--on');
    const into = takeOpt(args, '--in') ?? on, at = takeOpt(args, '--at'), slot = takeOpt(args, '--slot');
    const fields = Object.fromEntries(takeAll(args, '--field').map((f) => { const [n, v] = f.split('='); return [n, valueOf(v)]; }));
    if (!args[0] || into === undefined) throw usage('place <kind> --in <id> [--at x,y,z] [--slot n] [--field n=v]');
    return [{ op: 'place', name: 1, kind: args[0], in: node(into), ...(at ? { at: xyz(at) } : {}), ...(slot !== undefined ? { slot: Number(slot) } : {}), ...(Object.keys(fields).length ? { fields } : {}) }];
  }
  if (verb === 'move') {
    const at = takeOpt(args, '--at'), slot = takeOpt(args, '--slot');
    if (!args[0] || (!at && !related)) throw usage('move <id> --at x,y,z [--slot n] (or --beside, --facing)');
    if (!at) return [{ op: 'move', node: node(args[0]), ...(slot !== undefined ? { slot: Number(slot) } : {}) }];
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

/** A world verb's words as the daemon reads them: `{ verb, ...flags }`, numbers as given. */
export function worldVerbOf(verb, words) {
  const args = [...words], out = { verb };
  const flags = {
    weather: ['kind', 'clouds', 'rain', 'wind', 'minutes'], sky: ['palette', 'sun'], strike: ['at'],
    land: ['at', 'radius', 'amount', 'level', 'height', 'peak', 'path', 'area', 'rect', 'circle', 'edge', 'step', 'depth', 'width', 'side', 'face', 'steps', 'by'],
  }[verb];
  for (const f of flags) { const v = takeOpt(args, `--${f}`); if (v !== undefined) out[f] = v; }
  if (verb === 'strike' && out.at === undefined && args[0] !== undefined) out.at = args.shift();
  if (verb === 'land') {
    if (!args[0]) throw usage('land <raise|lower|flatten|knoll|hill|mountain|plateau|terrace|valley|ditch|cliff|pond|lake|water> [flags]');
    out.land = args.shift();
    if (out.land === 'water' && args[0] !== undefined) out.ref = args.shift();
    else if (out.at === undefined && args[0] !== undefined && /,/.test(args[0])) out.at = args.shift();
  }
  if (args.length) throw usage(`${verb}: unknown words ${args.join(' ')}`);
  return out;
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
  if (verb === 'status' || verb === 'stop' || verb === 'describe' || verb === 'redo') return { req: { op: verb }, creator };
  if (verb === 'build') return { build: buildOf(rest), creator };
  if (verb === 'undo') { const build = takeOpt(rest, '--build'); return { req: { op: 'undo', ...(build !== undefined ? { build } : {}) }, creator }; }
  if (verb === 'check' && WORLD_VERBS.includes(rest[0])) return { req: { op: 'check', world: worldVerbOf(rest[0], rest.slice(1)), ...under }, creator };
  if (WORLD_VERBS.includes(verb)) return { req: { op: 'edit', world: worldVerbOf(verb, rest), ...under }, creator };
  const build = takeOpt(rest, '--build'), step = takeOpt(rest, '--step');
  if ((build === undefined) !== (step === undefined)) throw usage('a build\'s step names both: --build <name> --step <name>');
  const named = build !== undefined ? { build, step } : {};
  const [v, words] = verb === 'check' ? [rest[0], rest.slice(1)] : [verb, rest];
  const relation = v === 'place' || v === 'move' ? relationOf(words) : null;
  let plain = relation ? withoutRelation(words) : words;
  // Beside another, in the same parent: the parent is filled in from describe.
  if (v === 'place' && relation?.beside !== undefined && !plain.includes('--in')) plain = [...plain, '--in', relation.beside];
  const ops = opsOf(v, plain, { related: !!relation });
  const req = verb === 'check' ? { op: 'check', ops, ...under } : { op: 'edit', ops, ...named, ...under };
  return { req, creator, ...(relation ? { relation } : {}) };
}

const RELATIONS = ['--beside', '--dir', '--dist', '--facing', '--on'];
/** A place's or a move's relation to another (#3694): `{ beside, dir, dist, facing, on }`, or null. */
export function relationOf(words) {
  const args = [...words], r = {};
  for (const k of RELATIONS) { const v = takeOpt(args, k); if (v !== undefined) r[k.slice(2)] = v; }
  return r.beside !== undefined || r.facing !== undefined || r.on !== undefined ? r : null;
}
const withoutRelation = (words) => { const args = [...words]; for (const k of ['--beside', '--dir', '--dist', '--facing']) takeOpt(args, k); return args; };

const COMPASS = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
/**
 * The batch with its relation resolved on `world` (describe's answer: each node's parent and `at`, mm in it): beside
 * puts the thing `dist` mm (default 1000) from the other toward `dir` (default e; north is −z), in the same parent;
 * on puts it in the other, in its first slot a thing may take and nothing holds; facing turns it about +y so its +z
 * faces the other, or the compass point. A relation that names what is not there is refused `relation-unknown`.
 */
export function resolve(req, relation, world) {
  const nodes = new Map(world.nodes.map((n) => [n.id, n]));
  const known = (id) => { const n = nodes.get(String(id)); if (!n) throw Object.assign(new Error(`no ${id} here`), { code: 'relation-unknown' }); return n; };
  const ops = req.ops.map((o) => ({ ...o }));
  const op = ops[0];
  const self = op.op === 'move' ? known(op.node) : null;
  if (relation.beside !== undefined) {
    const other = known(relation.beside);
    if (!other.at) throw Object.assign(new Error(`${other.id} has no place to stand beside`), { code: 'relation-unknown' });
    const [dx, dz] = COMPASS[relation.dir ?? 'e'] ?? (() => { throw usage('--dir is n, ne, e, se, s, sw, w or nw'); })();
    const dist = Number(relation.dist ?? 1000), k = Math.hypot(dx, dz);
    op.at = [Math.round(other.at[0] + (dx / k) * dist), other.at[1], Math.round(other.at[2] + (dz / k) * dist)];
    if (op.op === 'place') op.in = /^\d+$/.test(String(other.parent)) ? Number(other.parent) : other.parent;
  }
  if (relation.on !== undefined && op.op === 'place') {
    const other = known(relation.on);
    const kind = Object.entries(world.kinds ?? {}).find(([name]) => name.split('@')[0] === other.kind || name === other.kind)?.[1];
    const held = new Set(world.nodes.filter((n) => n.parent === other.id && n.slot !== undefined).map((n) => n.slot));
    const free = Object.entries(kind?.slots ?? {}).find(([n, s]) => s?.admits !== 'body' && !s?.posture && !held.has(Number(n)));
    if (free && op.slot === undefined) op.slot = Number(free[0]);
    op.at ??= [0, 0, 0];
  }
  if (relation.facing !== undefined) {
    const here = op.at ?? self?.at;
    const point = COMPASS[relation.facing];
    let d;
    if (point) d = point;
    else {
      const other = known(relation.facing);
      if (!other.at || !here) throw Object.assign(new Error(`cannot face ${relation.facing} from here`), { code: 'relation-unknown' });
      d = [other.at[0] - here[0], other.at[2] - here[2]];
    }
    op.yaw = ((Math.round((Math.atan2(d[0], d[1]) * 180_000) / Math.PI) % 360_000) + 360_000) % 360_000;
    if (op.op === 'move') op.at ??= self.at;
  }
  if (op.op === 'move' && !op.at) throw usage('move <id> needs --at, --beside or --facing');
  return { ...req, ops };
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
  const ttl = takeOpt(args, '--ttl'), to = takeOpt(args, '--to');
  const flag = (f) => { const k = args.indexOf(f); if (k >= 0) args.splice(k, 1); return k >= 0; };
  const helper = flag('--helper'), dry = flag('--dry');
  const [what, id] = args;
  if (what === 'rewind') {
    if (!id || to === undefined) throw usage('build rewind <build> --to <step> [--dry]');
    return { act: 'rewind', build: id, to, ...(dry ? { dry } : {}) };
  }
  if (ttl !== undefined && (!helper || !/^\d+$/.test(ttl) || Number(ttl) < 1 || Number(ttl) > 720)) throw usage('build claim --ttl <minutes> (1..720) needs --helper');
  const helped = helper ? { helper: true, ...(ttl !== undefined ? { ttl: Number(ttl) } : {}) } : {};
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
      return { act: 'claim', part: id, area: a, ...helped };
    }
    return { act: 'claim', part: id, district, ...(plots ? { plots: plots.split(',') } : {}), ...helped };
  }
  throw usage('build district [<id>] [--file plan.json] | build claim <part> ... [--helper] | build claims | build release <claim> | build rewind <build> --to <step>');
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
/** Runs a build request through the daemon's `fields` and `edit`; the answer to print. `mint(minutes)` asks the
 * gateway for a helper (#3727): `{ helper, token, home }`, the helper's home written with its token. */
export async function runBuild(b, ask, mint) {
  if (b.act === 'rewind') return ask({ op: 'undo', build: b.build, to: b.to, ...(b.dry ? { dry: true } : {}) });
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
  // A helper (#3727): minted first, so the claim names it; its token goes to its own home, never to this output.
  const h = b.helper ? await mint(b.ttl, id) : null;
  const out = await set(F_CLAIMS, [...rowsIn(root.fields[F_CLAIMS]), [id, named('part', b.part), ...area, ...(h ? [`helper:h${h.helper}`] : [])]]);
  if (out.ok === false) return out;
  return {
    ...out, claim: { id, part: slug(b.part), area, ...(h ? { helper: h.helper } : {}) },
    then: h ? `give the helper SOULS_HOME=${h.home}: its souls-god sends every edit under ${id}, inside it only, for ${h.minutes} minutes` : `send its edits with --claim ${id}`,
    ...(h ? { helper: { home: h.home, expires_in: h.expires_in } } : {}),
  };
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

/**
 * A helper for a claim (#3727): the gateway mints a creator-scope token that lapses after `minutes`, and it is kept in
 * a home of its own beside this one (`helpers/<claim>/`, as `.souls` is): its config, the world's kinds, the token and
 * the claim it builds under. The token is printed nowhere.
 */
async function mintHelper(home, creator, minutes, claim) {
  const seat = readSeat(home, creator);
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const world = config.worlds?.[seat.world];
  if (typeof world?.gateway !== 'string') throw Object.assign(new Error(`no gateway kept for ${seat.world}; pair again`), { code: 'no-gateway' });
  const url = new URL('/v2/creator-helper', world.gateway.replace(/^ws/, 'http'));
  if (minutes !== undefined) url.searchParams.set('minutes', String(minutes));
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${seat.token}` }, signal: AbortSignal.timeout(15_000) });
  const got = await r.json().catch(() => ({}));
  if (!r.ok || typeof got.token !== 'string') throw Object.assign(new Error(`the gateway refused a helper (${r.status})`), { code: got.refused ?? 'helper-refused' });
  const at = join(home, 'helpers', bare(claim));
  mkdirSync(join(at, 'kinds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(at, 'config.json'), JSON.stringify({ worlds: { [seat.world]: world } }));
  writeFileSync(join(at, 'credentials.json'), JSON.stringify({ souls: { [`c_${got.helper}`]: { [seat.world]: { token: got.token } } } }), { mode: 0o600 });
  writeFileSync(join(at, 'helper.json'), JSON.stringify({ claim, creator, expires_in: got.expires_in }));
  try { writeFileSync(join(at, 'kinds', `${seat.world}.kinds`), readFileSync(join(home, 'kinds', `${seat.world}.kinds`))); } catch { /* no kinds kept */ }
  return { helper: got.helper, home: at, expires_in: got.expires_in, minutes: Math.round(got.expires_in / 60) };
}

/** The claim a helper's home builds under (#3727), if this is one. */
function helperClaim(home) {
  try { return JSON.parse(readFileSync(join(home, 'helper.json'), 'utf8')).claim; } catch { return undefined; }
}

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
    const pkg = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
    const ask = (req, ms = 60_000) => call(home, creator, req, { pkg, ms: req.world?.verb === 'land' ? 130_000 : ms });
    // A relation is resolved on the daemon's copy: describe first, then the batch with its places filled in.
    let req = asked.relation ? resolve(asked.req, asked.relation, await ask({ op: 'describe' }, 15_000)) : asked.req;
    // A helper's home sends every edit under its claim (#3727).
    const scoped = helperClaim(home);
    if (scoped && req && (req.op === 'edit' || req.op === 'check') && req.claim === undefined) req = { ...req, claim: scoped };
    const answer = asked.build ? await runBuild(asked.build, ask, (minutes, claim) => mintHelper(home, creator, minutes, claim)) : await ask(req);
    out(withFix(answer));
    if (answer.ok === false) process.exitCode = 1;
  } catch (e) {
    out(withFix({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }));
    process.exitCode = 1;
  }
}

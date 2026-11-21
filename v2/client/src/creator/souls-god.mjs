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
//   souls-god.mjs define <record.json>          a kind of your own (#3697): a souls-entry/1 record (the format of
//                                                content/kinds), kept in the world under the full name it answers
//                                                (`defines`); a changed record is a new revision, and old things keep
//                                                theirs. Your own namespace only (not souls: or eden:)
//   souls-god.mjs define-kit <kit.json> [--ns <namespace>]   today's kit (a name and shapes in metres) as a record
//                                                with geometry.parts (kit.mjs), then defined; namespace `kit` unless given
//   souls-god.mjs upload <file.glb|png|jpg>     a model or a picture, through the world's check and hold point:
//                                                {hash, state: allowed|held}; an allowed one is served at `url`
//   souls-god.mjs check <any of these, or batch> ...   the same, checked on the copy only; nothing is sent
//   souls-god.mjs status | stop                  the daemon
//   any of them [--creator <c_id>]               which creator, when the home holds more than one
//
// A refusal prints its code, the operation that failed (`op`, its place in the batch) and a fix. The home is
// SOULS_HOME, else the nearest .souls; the daemon's library is SOULS_REPLICA_PKG. The token never leaves the daemon.

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, soulsWithTokens } from '../home/home.mjs';
import { worldOf } from '../cli/souls.mjs';
import { kitEntry } from './kit.mjs';

export const VERBS = ['pair', 'describe', 'define', 'define-kit', 'upload', 'place', 'move', 'set', 'remove', 'batch', 'weather', 'sky', 'strike', 'land', 'check', 'status', 'stop'];
/** The world's verbs (#3695): the daemon makes their sets on the world node from its copy (`world.mjs`). */
export const WORLD_VERBS = ['weather', 'sky', 'strike', 'land'];
const PAIR = join(dirname(fileURLToPath(import.meta.url)), '../pair/pair.mjs');

/** What to do about each refusal, by its name: the world's (G1, G2) and the command's own. */
export const FIX = {
  'edit.not-the-creator': 'this token is not the world\'s creator\'s: pair with --creator <its creator grant>',
  'edit.kind-unknown': 'use a kind describe lists under kinds (your own kinds too, once defined)',
  'kind.invalid': 'a souls-entry/1 record as content/kinds holds them: whole numbers, sections it can hold (no roles), its kind loads',
  'kind.too-large': 'a record is at most 64 KiB: fewer parts or a shorter text',
  'kind.namespace': 'name it in your own namespace (not souls: or eden:, nor one the world\'s own kinds use)',
  'kind.collision': 'that kind is defined already: place it by the full name describe lists',
  'kind.in-use': 'remove the things of that kind first, or in the same batch',
  'upload.size': 'a model is at most 3 MB and a picture 2 MB: make it smaller first',
  'upload.format': 'a GLB 2.0 model, a PNG or a JPEG',
  'upload.external-resource': 'export the GLB self-contained: every texture inside it',
  'upload.triangle-budget': 'at most 80,000 triangles: decimate it',
  'upload.off': 'this world takes no uploads',
  'kit.invalid': 'a kit is {"name", "shapes": [{"kind", "at": [x,y,z] m, ...}]}, as today\'s define-kit',
  'kit.program': 'write each shape out: repeat, radial, mirror and $params are not carried',
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
  'which-creator': 'name one with --creator',
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
  if (verb === 'define' || verb === 'define-kit') return [{ op: 'define', name: 1, entry: definitionOf(verb, args).entry }];
  throw usage(`one of ${VERBS.join(', ')}`);
}

/** #3697: the record a define or define-kit sends, read from its file, and what a kit did not carry. */
export function definitionOf(verb, words) {
  const args = [...words];
  const ns = takeOpt(args, '--ns');
  if (args.length !== 1) throw usage(verb === 'define' ? 'define <record.json>' : 'define-kit <kit.json> [--ns <namespace>]');
  let text;
  try { text = readFileSync(args[0], 'utf8'); } catch (e) { throw Object.assign(new Error(`${args[0]}: ${e.code ?? e.message}`), { code: 'file-unreadable' }); }
  let json;
  try { json = JSON.parse(text); } catch { throw Object.assign(new Error(`${args[0]} is not JSON`), { code: verb === 'define' ? 'kind.invalid' : 'kit.invalid' }); }
  if (verb === 'define') return { entry: text };
  const { entry, not_carried } = kitEntry(json, ns ? { ns } : {});
  return { entry: JSON.stringify(entry), ...(not_carried.length ? { not_carried } : {}) };
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
  const [verb = 'status', ...rest] = args;
  if (!VERBS.includes(verb)) throw Object.assign(new Error(`one of ${VERBS.join(', ')}`), { code: 'unknown-command' });
  if (verb === 'pair') return { pair: rest[0], creator };
  if (verb === 'status' || verb === 'stop' || verb === 'describe') return { req: { op: verb }, creator };
  if (verb === 'upload') {
    if (rest.length !== 1 || !/\.(glb|png|jpe?g)$/i.test(rest[0])) throw usage('upload <file.glb|png|jpg>');
    return { req: { op: 'upload', path: resolve(rest[0]) }, creator };
  }
  if (verb === 'check' && WORLD_VERBS.includes(rest[0])) return { req: { op: 'check', world: worldVerbOf(rest[0], rest.slice(1)) }, creator };
  if (verb === 'check') return { req: { op: 'check', ops: opsOf(rest[0], rest.slice(1)) }, creator };
  if (WORLD_VERBS.includes(verb)) return { req: { op: 'edit', world: worldVerbOf(verb, rest) }, creator };
  if (verb === 'define-kit') {
    const { not_carried } = definitionOf(verb, rest);
    return { req: { op: 'edit', ops: opsOf(verb, rest) }, creator, ...(not_carried ? { say: { not_carried } } : {}) };
  }
  return { req: { op: 'edit', ops: opsOf(verb, rest) }, creator };
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  try {
    const asked = requestOf(process.argv.slice(2));
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
    if (asked.pair !== undefined) { out(await pairing(home, asked.pair, asked.creator)); process.exit(0); }
    const creators = soulsWithTokens(home).filter((id) => id.startsWith('c_'));
    const creator = asked.creator ?? (creators.length === 1 ? creators[0] : undefined);
    if (!creator) throw Object.assign(new Error(`creators here: ${creators.join(', ') || 'none; pair first'}`), { code: 'which-creator' });
    const answer = await call(home, creator, asked.req, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: asked.req.world?.verb === 'land' ? 130_000 : asked.req.op === 'upload' ? 40_000 : 15_000 });
    out(withFix({ ...answer, ...(asked.say ?? {}) }));
    if (answer.ok === false) process.exitCode = 1;
  } catch (e) {
    out(withFix({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }));
    process.exitCode = 1;
  }
}

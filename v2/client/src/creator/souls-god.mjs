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
//   place <kind> --in <id> --beside <id> [--dir n|ne|e|se|s|sw|w|nw] [--dist mm]   beside another (default e, 1000)
//   place <kind> --on <id>                       in or on another: its first free slot for a thing, if it has one
//   place|move ... --facing <id|n|e|s|w>         turned to face another, or a compass point
//   any edit verb --build <name> --step <name>  a build's step (#3694): one batch the world keeps under that name
//   souls-god.mjs undo [--build <name>] | redo   the newest edit undone (a whole build, step by step), or redone
//   souls-god.mjs status | stop                  the daemon
//   any of them [--creator <c_id>]               which creator, when the home holds more than one
//
// A refusal prints its code, the operation that failed (`op`, its place in the batch) and a fix. The home is
// SOULS_HOME, else the nearest .souls; the daemon's library is SOULS_REPLICA_PKG. The token never leaves the daemon.

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, soulsWithTokens } from '../home/home.mjs';
import { worldOf } from '../cli/souls.mjs';

export const VERBS = ['pair', 'describe', 'place', 'move', 'set', 'remove', 'batch', 'check', 'undo', 'redo', 'status', 'stop'];
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

/** The daemon request the arguments make, and the creator named. */
export function requestOf(argv) {
  const args = [...argv];
  const creator = takeOpt(args, '--creator');
  const [verb = 'status', ...rest] = args;
  if (!VERBS.includes(verb)) throw Object.assign(new Error(`one of ${VERBS.join(', ')}`), { code: 'unknown-command' });
  if (verb === 'pair') return { pair: rest[0], creator };
  if (verb === 'status' || verb === 'stop' || verb === 'describe' || verb === 'redo') return { req: { op: verb }, creator };
  if (verb === 'undo') { const build = takeOpt(rest, '--build'); return { req: { op: 'undo', ...(build !== undefined ? { build } : {}) }, creator }; }
  const build = takeOpt(rest, '--build'), step = takeOpt(rest, '--step');
  if ((build === undefined) !== (step === undefined)) throw usage('a build\'s step names both: --build <name> --step <name>');
  const named = build !== undefined ? { build, step } : {};
  const [v, words] = verb === 'check' ? [rest[0], rest.slice(1)] : [verb, rest];
  const relation = v === 'place' || v === 'move' ? relationOf(words) : null;
  let plain = relation ? withoutRelation(words) : words;
  // Beside another, in the same parent: the parent is filled in from describe.
  if (v === 'place' && relation?.beside !== undefined && !plain.includes('--in')) plain = [...plain, '--in', relation.beside];
  const ops = opsOf(v, plain, { related: !!relation });
  const req = verb === 'check' ? { op: 'check', ops } : { op: 'edit', ops, ...named };
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
    const pkg = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
    // A relation is resolved on the daemon's copy: describe first, then the batch with its places filled in.
    const req = asked.relation ? resolve(asked.req, asked.relation, await call(home, creator, { op: 'describe' }, { pkg, ms: 15_000 })) : asked.req;
    const answer = await call(home, creator, req, { pkg, ms: 60_000 });
    out(withFix(answer));
    if (answer.ok === false) process.exitCode = 1;
  } catch (e) {
    out(withFix({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }));
    process.exitCode = 1;
  }
}

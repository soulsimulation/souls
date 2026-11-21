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
//   souls-god.mjs event <room or ground id> '<words>' --when HH:MM|<world µs>us [--for <minutes>] [--at x,y,z]
//                                                a calendar entry there (eden:calendar_entry), its words kept by the
//                                                world for everyone; HH:MM is its next one on the world's calendar
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

export const VERBS = ['pair', 'describe', 'place', 'move', 'set', 'remove', 'batch', 'check', 'status', 'stop', 'event'];
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
  'which-creator': 'name one with --creator',
  'when.no-calendar': 'the copy has no world clock yet: run status until connected is true, or give --when <world µs>us',
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

/** A calendar entry's kind and its fields (start, end in world µs; words): `content/kinds/calendar/entry.json`. */
export const ENTRY = { kind: 'eden:calendar_entry', start: 28, end: 29, words: 30 };
const MINUTE_US = 60_000_000;

/** The batch that posts one event: a calendar entry placed in `into`, from `start` for `minutes`, with its words. */
export function eventOps({ into, words, start, minutes = 60, at }) {
  return [{ op: 'place', name: 1, kind: ENTRY.kind, in: node(into), ...(at ? { at } : {}),
    fields: { [ENTRY.start]: start, [ENTRY.end]: start + minutes * MINUTE_US, [ENTRY.words]: { words } } }];
}

/** `event`'s words: where, what, when (HH:MM, or world µs as `<n>us`), how long and the spot. */
export function eventOf(words) {
  const args = [...words];
  const when = takeOpt(args, '--when'), long = takeOpt(args, '--for'), at = takeOpt(args, '--at');
  const how = "event <room or ground id> '<words>' --when HH:MM|<world µs>us [--for <minutes>] [--at x,y,z]";
  if (args.length !== 2 || !args[1].trim() || !when) throw usage(how);
  const minutes = long === undefined ? 60 : Number(long);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw usage('--for is whole minutes, 1 to a week');
  const us = /^(\d+)us$/.exec(when), hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(when);
  if (!us && !hm) throw usage(how);
  return { into: args[0], words: args[1].trim(), ...(us ? { start: Number(us[1]) } : { when }), minutes, ...(at ? { at: xyz(at) } : {}) };
}

/** The daemon request the arguments make, and the creator named. */
export function requestOf(argv) {
  const args = [...argv];
  const creator = takeOpt(args, '--creator');
  const [verb = 'status', ...rest] = args;
  if (!VERBS.includes(verb)) throw Object.assign(new Error(`one of ${VERBS.join(', ')}`), { code: 'unknown-command' });
  if (verb === 'pair') return { pair: rest[0], creator };
  if (verb === 'event') return { event: eventOf(rest), creator };
  if (verb === 'status' || verb === 'stop' || verb === 'describe') return { req: { op: verb }, creator };
  if (verb === 'check') return { req: { op: 'check', ops: opsOf(rest[0], rest.slice(1)) }, creator };
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
    if (asked.event) {
      // HH:MM is its next one on the world's published calendar, read from the creator's copy.
      const e = asked.event, ask = (r) => call(home, creator, r, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: 15_000 });
      const when = e.start === undefined ? await ask({ op: 'when', at: e.when }) : { ok: true, worldUs: e.start };
      asked.req = when.ok ? { op: 'edit', ops: eventOps({ ...e, start: when.worldUs }) } : null;
      if (!asked.req) { out(withFix(when)); process.exit(1); }
    }
    const answer = await call(home, creator, asked.req, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms: 15_000 });
    out(withFix(answer));
    if (answer.ok === false) process.exitCode = 1;
  } catch (e) {
    out(withFix({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }));
    process.exitCode = 1;
  }
}

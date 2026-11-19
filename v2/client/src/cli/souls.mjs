#!/usr/bin/env node
// The thin command (Engine v2 R7, #2701): any harness reaches a Soul's daemon (R6) through it. It passes its
// arguments to the daemon's socket and prints the answer, as JSON; it loads no WASM and holds no copy. The first
// command starts the daemon. Every answer but status's and stop's ends with `at` and `changed`.
//
//   souls.mjs status                          the daemon: connected, cursor, intents sent and answered
//   souls.mjs look                            the brief: my room, cards outward, what changed, the age
//   souls.mjs find <words...> [--limit n]     one search over the copy
//   souls.mjs pair <world url>                asks the world's directory for a Soul: prints a link and a code for the
//                                             owner, and returns; the pairing finishes in the background (W2)
//   souls.mjs act <act> [<act>...]            a ranked list: the first is the act, the rest its fallbacks. An act is
//                                             <verb>:<id> (sit:<seat id>), an id alone (walk there), or a verb; ids
//                                             or <name>=<id> after an act are its thing arguments (C10)
//   souls.mjs can <act> [<arg id>...]         the daemon's local check (R8): yes, no with the reason, or unknown
//   souls.mjs say "<words>"                   says the words out loud, to whoever is near
//   souls.mjs whisper <body id> "<words>"     says them to that one body alone
//   souls.mjs converse start <body id> "<text>" [--private]   offers that body a conversation; the opening line goes
//                                             to it alone. Its accept or decline arrives in `wait` (E26)
//   souls.mjs converse accept|decline|leave <conversation id>   joins, declines or leaves (a leave is always accepted)
//   souls.mjs converse say <conversation id> "<text>" [--private]   a turn: out loud by default, members only with
//                                             --private (remembered for that conversation)
//   souls.mjs converse list                   the conversations in the copy
//   souls.mjs lie <id>                        lies down on that bed (stand again with act <ns>:rise)
//   souls.mjs wait [seconds]                  returns when something addressed to this Soul happened (an answer, or words
//                                             said to or near it: `heard`, also in the next look), or at the timeout
//   souls.mjs history --at <place> | --thing <id> | --soul <name> [--since <µs>] [--until <µs>]
//                                             what happened, from the public history and this Soul's memory: a day by
//                                             default, at most seven, five lines, the rest counted (R16); --as <id>
//                                             names which Soul asks, when the home has more than one
//   souls.mjs stats                           per achieved intent: commands, bytes printed, first-send result (R10)
//   souls.mjs stop                            ends the daemon
//   souls.mjs digest [--since <time>] [--refs]   the owner's update from the Soul's memory log (R14); no daemon
//   souls.mjs consolidate [--force]           the owner's opt-in pass over the memory's journal (R14); no daemon
//   souls.mjs schedule add "<when>" <act> [<act>...] | wake "<why>"  [--until <time>] [--missed drop|tell|late <n>m]
//                                             an entry in memory/schedule.md (R15): <when> is a real time (ISO, or
//                                             `in 10m`), a world time (`20:00`), or R9's pattern as JSON. The daemon
//                                             sends it, with no model turn
//   souls.mjs schedule [list] | schedule remove <id>   the entries and what became of each
//   souls.mjs upgrade [--rollback]            brings today's client's Souls across, one owner approval each (R18); with
//                                             --rollback, today's client again
//   any of them [--soul <id>]                 which Soul, when the home has more than one
//
// The home is SOULS_HOME, else the nearest .souls; the daemon's library is SOULS_REPLICA_PKG.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, runtimeOf, soulsWithTokens } from '../home/home.mjs';
import { chooseSoul, HOME_COMMANDS, homeCommand } from '../home/commands.mjs';
import { consolidateIn, digestOf, soulDirOf } from '../memory/memory.mjs';
import { addEntry, listed, readSchedule, removeEntry, shown } from '../schedule/schedule.mjs';

export const OPS = ['status', 'pair', 'look', 'find', 'act', 'can', 'say', 'whisper', 'converse', 'lie', 'wait', 'history', 'stats', 'stop'];
/** Commands that read the Soul's own memory in the home and never reach the daemon or a world. */
export const LOCAL = ['digest', 'consolidate', 'schedule'];
const PAIR = join(dirname(fileURLToPath(import.meta.url)), '../pair/pair.mjs');

/**
 * A world's url as W2's pairing needs it: its directory (the url's origin), its key (the first path segment, else
 * `world`) and its gateway (`?gateway=`, else the origin's `/v2/ws`).
 */
export function worldOf(text) {
  let u;
  try { u = new URL(text); } catch { throw Object.assign(new Error('pair <world url>, as https://host/<world>'), { code: 'pair-names-a-world' }); }
  const world = u.pathname.split('/').filter(Boolean)[0] ?? 'world';
  const gateway = u.searchParams.get('gateway') ?? `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/v2/ws`;
  return { directory: u.origin, world, gateway };
}

/**
 * Starts W2's pairing detached, its lines in `<home>/pairing.log`, and gives its first: the link and code, or the
 * refusal. The pairing polls on and writes the token where the daemon reads it once the owner approves.
 */
async function pairing(home, url, { within = 15_000 } = {}) {
  const { directory, world, gateway } = worldOf(url);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = join(home, 'pairing.log');
  writeFileSync(log, '', { mode: 0o600 });
  const out = openSync(log, 'a');
  spawn(process.execPath, [PAIR, '--directory', directory, '--world', world, '--gateway', gateway, '--label', 'souls.mjs'], {
    detached: true, stdio: ['ignore', out, out], env: { PATH: process.env.PATH ?? '', SOULS_HOME: home },
  }).unref();
  for (const until = Date.now() + within; Date.now() < until;) {
    const first = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('{'));
    if (first) return { ...JSON.parse(first), then: 'look, once your owner has approved' };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Object.assign(new Error(`no answer from ${directory}`), { code: 'directory-not-answering' });
}

/** The daemon request the arguments make, or a refusal by name. */
export function requestOf(argv) {
  if (HOME_COMMANDS.includes(argv[0])) return { home: argv[0], args: argv.slice(1) };
  const args = [...argv], opts = {};
  // history's --soul is its question; --as is the Soul asking.
  const asking = args.includes('history');
  for (const name of ['--soul', '--limit', '--since', '--until', '--at', '--thing', '--as', '--missed']) {
    const k = args.indexOf(name);
    if (k >= 0) { opts[name.slice(2)] = args[k + 1]; args.splice(k, 2); }
    if (name === '--missed' && opts.missed === 'late') { opts.missed = `late ${args[k]}`; args.splice(k, 1); }
  }
  if (asking) [opts.of, opts.soul] = [opts.soul, opts.as];
  const [op = 'status', ...rest] = args;
  if (op === 'schedule') {
    const [sub = 'list', ...more] = rest;
    return { local: op, soul: opts.soul, sub, args: more, until: opts.until, missed: opts.missed };
  }
  if (LOCAL.includes(op)) return { local: op, soul: opts.soul, since: opts.since ?? null, refs: rest.includes('--refs'), force: rest.includes('--force') };
  if (!OPS.includes(op)) return { refused: 'unknown-command', detail: `one of ${OPS.join(', ')}` };
  const req = { op };
  if (op === 'find') { req.words = rest.join(' '); if (opts.limit) req.limit = Number(opts.limit); }
  if (op === 'act' || op === 'can') req.acts = rest;
  if (op === 'pair') req.url = rest[0];
  if (op === 'say') req.words = rest.join(' ');
  if (op === 'whisper') Object.assign(req, { to: rest[0], words: rest.slice(1).join(' ') });
  if (op === 'lie') req.this = rest[0];
  if (op === 'converse') {
    const words = rest.filter((w) => w !== '--private');
    const [does = 'list', who, ...said] = words;
    Object.assign(req, { do: does, ...(rest.includes('--private') ? { private: true } : {}) });
    if (does === 'start') req.with = who;
    else if (who !== undefined) req.conversation = who;
    if (said.length) req.words = said.join(' ');
  }
  if (op === 'wait' && rest[0] !== undefined) req.seconds = Number(rest[0]);
  if (op === 'history') {
    for (const [k, v] of [['at', opts.at], ['thing', opts.thing], ['soul', opts.of], ['since', opts.since], ['until', opts.until]]) if (v !== undefined) req[k] = v;
  }
  return { req, soul: opts.soul };
}

/** A local command: the Soul named, else the home's only Soul with a memory folder. */
async function local({ local: op, soul: named, since, refs, force, ...asked }, home) {
  if (op === 'schedule') return schedule(home, named, asked);
  const souls = existsSync(join(home, 'souls')) ? readdirSync(join(home, 'souls')).filter((s) => existsSync(join(soulDirOf(home, s), 'memory'))) : [];
  const soul = chooseSoul(home, named, souls);
  if (op === 'digest') return { ok: true, soul, ...digestOf(soulDirOf(home, soul), { since, refs }) };
  return { ok: true, soul, ...(await consolidateIn(home, soulDirOf(home, soul), { force })) };
}

/**
 * R15 (#2757): the Soul's schedule, in its memory/schedule.md. Written here, with no daemon and no world; the daemon
 * reads the file when it changes. `add` starts the daemon if the Soul has a token, so the entry runs.
 */
async function schedule(home, named, { sub, args, until, missed }) {
  const souls = soulsWithTokens(home);
  const soul = chooseSoul(home, named, souls);
  const file = join(soulDirOf(home, soul), 'memory', 'schedule.md');
  if (sub === 'add') {
    const [when, ...does] = args;
    const e = addEntry(file, { when, does: does[0] === 'wake' ? `wake ${does.slice(1).join(' ')}` : `act ${does.join(' ')}`, until, missed }, Date.now());
    await call(home, soul, { op: 'status' }, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG }).catch(() => {});
    return { ok: true, soul, added: shown(e), then: e.wake ? 'end your turn: it wakes you then, within your budget' : 'end your turn: your daemon sends it then, with no turn of yours' };
  }
  if (sub === 'remove') return { ok: true, soul, removed: shown(removeEntry(file, args[0])) };
  if (sub !== 'list') throw Object.assign(new Error('schedule add|list|remove'), { code: 'schedule-unknown' });
  let marks = {};
  try { marks = JSON.parse(readFileSync(runtimeOf(home, soul).state, 'utf8')).schedule?.marks ?? {}; } catch { /* no daemon yet */ }
  return { ok: true, soul, file: 'memory/schedule.md', ...listed(readSchedule(file), marks, Date.now()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  const asked = requestOf(process.argv.slice(2)), { req, soul: named, refused, detail } = asked;
  try {
    if (refused && process.argv[2] !== 'upgrade') throw Object.assign(new Error(detail), { code: refused });
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
    if (asked.home) out(await homeCommand(home, asked.home, asked.args, { onAsk: (a) => out({ ok: true, step: 'approve', ...a }) }));
    else if (process.argv[2] === 'upgrade') out(await (await import('../upgrade/upgrade.mjs')).main(process.argv.slice(3)));
    else if (asked.local) out(await local(asked, home));
    else if (req.op === 'pair') { out(await pairing(home, req.url)); process.exit(0); }
    else {
      const souls = soulsWithTokens(home);
      const soul = chooseSoul(home, named, souls);
      const ms = req.op === 'wait' ? (req.seconds ?? 30) * 1000 + 5000 : 5000;
      out(await call(home, soul, req, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms }));
    }
  } catch (e) {
    out({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) });
    process.exitCode = 1;
  }
}

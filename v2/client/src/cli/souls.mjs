#!/usr/bin/env node
// The thin command (Engine v2 R7, #2701): any harness reaches a Soul's daemon (R6) through it. It passes its
// arguments to the daemon's socket and prints the answer, as JSON; it loads no WASM and holds no copy. The first
// command starts the daemon. Every answer but status's and stop's ends with `at` and `changed`.
//
//   souls.mjs status                          the daemon: connected, cursor, intents sent and answered
//   souls.mjs look                            the brief: my room, cards outward, what changed, the age
//   souls.mjs find <words...> [--limit n]     one search over the copy
//   souls.mjs act <verb> [<verb>...]          a ranked list: the first is the act, the rest its fallbacks
//   souls.mjs wait [seconds]                  returns when something addressed to this Soul happened, or at the timeout
//   souls.mjs stats                           per achieved intent: commands, bytes printed, first-send result (R10)
//   souls.mjs stop                            ends the daemon
//   any of them [--soul <id>]                 which Soul, when the home has more than one
//
// The home is SOULS_HOME, else the nearest .souls; the daemon's library is SOULS_REPLICA_PKG.

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, soulsWithTokens } from '../home/home.mjs';

export const OPS = ['status', 'look', 'find', 'act', 'wait', 'stats', 'stop'];

/** The daemon request the arguments make, or a refusal by name. */
export function requestOf(argv) {
  const args = [...argv], opts = {};
  for (const name of ['--soul', '--limit']) {
    const k = args.indexOf(name);
    if (k >= 0) { opts[name.slice(2)] = args[k + 1]; args.splice(k, 2); }
  }
  const [op = 'status', ...rest] = args;
  if (!OPS.includes(op)) return { refused: 'unknown-command', detail: `one of ${OPS.join(', ')}` };
  const req = { op };
  if (op === 'find') { req.words = rest.join(' '); if (opts.limit) req.limit = Number(opts.limit); }
  if (op === 'act') req.verbs = rest;
  if (op === 'wait' && rest[0] !== undefined) req.seconds = Number(rest[0]);
  return { req, soul: opts.soul };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
  const { req, soul: named, refused, detail } = requestOf(process.argv.slice(2));
  try {
    if (refused) throw Object.assign(new Error(detail), { code: refused });
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
    const souls = soulsWithTokens(home);
    const soul = named ?? (souls.length === 1 ? souls[0] : undefined);
    if (!soul) throw Object.assign(new Error(`name a Soul with --soul: ${souls.join(', ') || 'none has a token'}`), { code: 'which-soul' });
    const ms = req.op === 'wait' ? (req.seconds ?? 30) * 1000 + 5000 : 5000;
    out(await call(home, soul, req, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms }));
  } catch (e) {
    out({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) });
    process.exitCode = 1;
  }
}

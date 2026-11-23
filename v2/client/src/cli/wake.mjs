// The `wake` command (Engine v2 R13, #2753): the Soul's wake rules and its budget, held by its daemon
// (../wake/wake.mjs). A harness holds `client.mjs wait --seconds 600` in its background mechanism as the reader.
//
//   node v2/client/src/cli/wake.mjs [--soul <id>]                                   the rules, queue and budget
//   node v2/client/src/cli/wake.mjs add '<rule json>' [--soul <id>]                e.g. someone spoke to me:
//     '{"when":{"event":"eden:say","toMe":true},"why":"someone spoke to you","expires":86400}'
//   node v2/client/src/cli/wake.mjs remove <id> [--soul <id>]
//   node v2/client/src/cli/wake.mjs budget quiet|normal|lively|unlimited|<n> [--day <n>] [--soul <id>]
//
// Prints the daemon's answer as JSON. The home and the library are found as client.mjs finds them.

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { homedir } from 'node:os';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, soulsWithTokens } from '../home/home.mjs';

/** The daemon request for `wake` arguments (without --soul). Throws what is wrong. */
export function wakeRequest(args) {
  const usage = "usage: wake | wake add '<rule json>' | wake remove <id> | wake budget <quiet|normal|lively|unlimited|n> [--day <n>]";
  const [what, arg, ...rest] = args;
  if (what === undefined || what === 'list') { if (arg !== undefined) throw new Error(usage); return { op: 'wake', do: 'list' }; }
  if (what === 'remove' && arg && !rest.length) return { op: 'wake', do: 'remove', id: arg };
  if (what === 'add' && arg && !rest.length) {
    let rule;
    try { rule = JSON.parse(arg); } catch { throw new Error('wake add: the rule must be JSON'); }
    return { op: 'wake', do: 'add', rule };
  }
  if (what === 'budget') {
    const req = { op: 'wake', do: 'budget' };
    const words = [arg, ...rest].filter((w) => w !== undefined);
    for (let k = 0; k < words.length; k++) {
      if (words[k] === '--day') { req.day = /^\d+$/.test(words[k + 1] ?? '') ? Number(words[++k]) : NaN; continue; }
      if ('hour' in req) throw new Error(usage);
      req.hour = /^\d+$/.test(words[k]) ? Number(words[k]) : words[k];
    }
    if (!('hour' in req) && !('day' in req)) throw new Error(usage);
    return req;
  }
  throw new Error(usage);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const k = args.indexOf('--soul');
  const named = k >= 0 ? args.splice(k, 2)[1] : undefined;
  try {
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
    const souls = soulsWithTokens(home);
    const soul = named ?? (souls.length === 1 ? souls[0] : undefined);
    if (!soul) throw Object.assign(new Error(`name a Soul with --soul: ${souls.join(', ') || 'none has a token'}`), { code: 'which-soul' });
    console.log(JSON.stringify(await call(home, soul, wakeRequest(args), { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG })));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code ?? 'refused', detail: String(e.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  }
}

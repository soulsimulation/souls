// The `reflex` command (Engine v2 R9, #2728): the Soul's reflex table, held by its daemon (../reflex/reflex.mjs).
//
//   node v2/client/src/cli/reflex.mjs [--soul <id>]                         the rules
//   node v2/client/src/cli/reflex.mjs add '<rule json>' [--soul <id>]      e.g. a standing consent:
//     '{"when":{"event":"eden:offer","from":["s_ada"],"fields":{"2":"eden:high-five"}},
//       "send":{"verb":"eden:join","target":"$field:1"},"expires":3600,"max":5}'
//   node v2/client/src/cli/reflex.mjs remove <id> [--soul <id>]
//
// Prints the daemon's answer as JSON. The home and the library are found as client.mjs finds them.

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { homedir } from 'node:os';
import { DEFAULT_PKG, call } from '../daemon/client.mjs';
import { findHome, soulsWithTokens } from '../home/home.mjs';

/** The daemon request for `reflex` arguments (without --soul). Throws what is wrong. */
export function reflexRequest(args) {
  const [what, arg, ...extra] = args;
  const usage = "usage: reflex | reflex add '<rule json>' | reflex remove <id>";
  if (extra.length) throw new Error(usage);
  if (what === undefined || what === 'list') return { op: 'reflex', do: 'list' };
  if (what === 'remove' && arg) return { op: 'reflex', do: 'remove', id: arg };
  if (what === 'add' && arg) {
    let rule;
    try { rule = JSON.parse(arg); } catch { throw new Error('reflex add: the rule must be JSON'); }
    return { op: 'reflex', do: 'add', rule };
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
    const req = reflexRequest(args);
    console.log(JSON.stringify(await call(home, soul, req, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG })));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code ?? 'refused', detail: String(e.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  }
}

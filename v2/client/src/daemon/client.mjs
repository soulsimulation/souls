// Talking to a Soul's daemon (Engine v2 R6, #2700), and starting it on the first command. The daemon is spawned
// detached, in its own session, with its output going to its log, so it outlives the command and the chat that ran
// it. It is given the home, the Soul's id and the library's folder; never the token, and an environment with none
// of the caller's variables but PATH.
//
//   node v2/client/src/daemon/client.mjs <op> [--soul <id>] [--verb <verb>]      prints the daemon's answer, as JSON
//     [--for <message id>] (an act serving an owner's message) [--seconds <n>] (wait's, R13: a harness's reader)
//   The home is SOULS_HOME, else the nearest .souls; the library is SOULS_REPLICA_PKG, else v2/target/wasm-load/pkg.

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atSocket, findHome, runtimeOf, soulsWithTokens } from '../home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PKG = resolve(here, '../../../target/wasm-load/pkg');

/** One request to the daemon at `socket`; its answer. Rejects if no daemon listens there. */
export function request(socket, req, ms = 5000) {
  return new Promise((ok, fail) => {
    const c = atSocket(socket, (path) => createConnection(path));
    let buf = '';
    const timer = setTimeout(() => { c.destroy(); fail(Object.assign(new Error('daemon-not-answering'), { code: 'daemon-not-answering' })); }, ms);
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', (d) => {
      buf += d;
      const k = buf.indexOf('\n');
      if (k >= 0) { clearTimeout(timer); c.end(); ok(JSON.parse(buf.slice(0, k))); }
    });
    c.on('error', (e) => { clearTimeout(timer); fail(e); });
  });
}

/** Starts the Soul's daemon, detached; gives its pid. A daemon already running refuses this one by name. */
export function start(home, soul, pkg = DEFAULT_PKG) {
  const rt = runtimeOf(home, soul);
  const out = openSync(rt.log, 'a', 0o600);
  const child = spawn(process.execPath, [join(here, 'daemon.mjs'), '--home', home, '--soul', soul, '--pkg', pkg], {
    detached: true,
    cwd: rt.dir,
    stdio: ['ignore', out, out],
    env: { PATH: process.env.PATH ?? '' },
  });
  child.unref();
  return child.pid;
}

/** Sends `req` to the Soul's daemon, starting it first if none answers. */
export async function call(home, soul, req, { pkg = DEFAULT_PKG, within = 5000, ms = 5000 } = {}) {
  const rt = runtimeOf(home, soul);
  try {
    return await request(rt.socket, req, ms);
  } catch (e) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e;
  }
  start(home, soul, pkg);
  const until = Date.now() + within;
  for (;;) {
    try {
      return { ...(await request(rt.socket, req, ms)), started: true };
    } catch (e) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(e.code) || Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
  const souls = soulsWithTokens(home);
  const soul = opt('--soul') ?? (souls.length === 1 ? souls[0] : undefined);
  try {
    if (!soul) throw Object.assign(new Error(`name a Soul with --soul: ${souls.join(', ') || 'none has a token'}`), { code: 'which-soul' });
    const req = { op: args[0] ?? 'status', ...(opt('--verb') ? { verb: opt('--verb') } : {}),
      ...(opt('--for') ? { for: opt('--for') } : {}), ...(opt('--seconds') ? { seconds: Number(opt('--seconds')) } : {}) };
    const ms = 5000 + (req.op === 'wait' ? 1000 * Math.min(Number(req.seconds ?? 30), 600) : 0);
    console.log(JSON.stringify(await call(home, soul, req, { pkg: process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG, ms })));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }));
    process.exitCode = 1;
  }
}

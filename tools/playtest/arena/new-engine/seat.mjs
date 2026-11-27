// A playtest seat on the new engine (0.135 P1): one Soul paired as v2/client/served/e2e/world.test.mjs pairs one (the
// new client's `pair.mjs` against the directory, approved once by a test person through the dev sign-in), then joined
// with `life:join`, and driven only by the new client's thin command (`v2/client/src/cli/souls.mjs`). Each command and
// its JSON answer is appended to the seat's transcript (`commands.jsonl`). No model runs here: a seat is a home and a
// command line; whoever drives it (a script, a director, an agent) chooses the words.
//
//   const seat = await pairSeat({ world, dir, label, pkg });   // world: arena/new-engine/world.mjs startWorld's answer
//   await seat.join(); await seat.cli('act', '<id>', '--wait'); await seat.events(); await seat.stop();
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { sleep } from '../../lib/clock.mjs';
import { runOwnedCommand } from './world.mjs';

export const CLI = join(REPO_ROOT, 'v2/client/src/cli/souls.mjs');
export const PAIR = join(REPO_ROOT, 'v2/client/src/pair/pair.mjs');
export const REPLICA_PKG = process.env.SOULS_REPLICA_PKG ?? join(REPO_ROOT, 'v2/target/wasm-load/pkg');

/** The last JSON line of a command's output, or null. */
export function lastJson(text) {
  for (const line of String(text).trim().split('\n').reverse()) { try { return JSON.parse(line); } catch { /* not JSON */ } }
  return null;
}

/** The child's environment: only what the client needs (no launcher variables, never a model key), its home named. */
export const seatEnv = (home, pkg = REPLICA_PKG) => ({ PATH: process.env.PATH, HOME: process.env.HOME, SOULS_HOME: home, SOULS_REPLICA_PKG: pkg, BRAIN_MODE: 'fake' });

/** pair.mjs's arguments for a world (as the e2e test passes them). */
export const pairArgs = (world, label) => ['--directory', world.directory, '--world', world.world, '--gateway', world.gateway,
  '--device', 'playtest machine', '--label', label, '--advert', `${world.page}views/world.json`];

function runNode(args, { env, cwd, timeoutMs = 120_000, onText, onSpawn, signal } = {}) {
  if (onSpawn) return (async () => {
    let out='';
    try { const text=await runOwnedCommand(process.execPath,args,{env,cwd,timeoutMs,signal,onSpawn(child,mode){onSpawn(child,mode);child.stdout.on('data',d=>{out+=d;onText?.(out);});}});return {code:0,out:text,err:''}; }
    catch(error){return {code:1,out,err:String(error)};}
  })();
  return new Promise((ok) => {
    const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; onText?.(out); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); ok({ code, out, err }); });
  });
}

/** Pairs one Soul: pair.mjs asks, the test person `owner` (default `label`) approves, the token comes back into the
 *  seat's home. `name`: the Soul's name, saved by its owner on the directory (`/v1/account/souls/profile`), which the
 *  world gives its body (the page's name tag, its search). */
export async function pairSeat({ world, dir, label, owner = label, name = null, pkg = REPLICA_PKG, approveMs = 60_000, checkout = REPO_ROOT, onSpawn, signal }) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(label ?? '')) throw new Error('label: lowercase letters, digits, dashes');
  const folder = resolve(dir, label), home = join(folder, '.souls'), log = join(folder, 'commands.jsonl');
  mkdirSync(folder, { recursive: true });
  const env = seatEnv(home, pkg);
  let asked = null;
  const asking = runNode([join(checkout,'v2/client/src/pair/pair.mjs'), ...pairArgs(world, label)], { cwd: folder, env, timeoutMs: approveMs + 30_000, onSpawn, signal,
    onText: (t) => { asked ??= t.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve') ?? null; } });
  const until = Date.now() + approveMs;
  while (!asked && Date.now() < until) { signal?.throwIfAborted(); await sleep(50); }
  signal?.throwIfAborted();
  if (!asked) throw new Error(`${label}: no pairing code in ${approveMs / 1000} s`);
  const approve = await fetch(new URL('/v1/pair/approve', world.directory), { method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.any([signal,AbortSignal.timeout(10000)].filter(Boolean)), body: JSON.stringify({ code: asked.code, confirm: true, test_person: owner }) });
  if (approve.status !== 200) throw new Error(`${label}: the owner's approval answered ${approve.status}`);
  const done = await asking;
  const said = lastJson(done.out);
  if (done.code !== 0 || !said?.ok) throw new Error(`${label}: pairing failed: ${done.out.slice(-300)} ${done.err.slice(-300)}`);
  if (name) {
    // the directory keys the Soul as its owner's list names it (`soul-<hex>-<n>`; the client's `s_<hex>-<n>`)
    const post = (path, body) => fetch(new URL(path, world.directory), { method: 'POST', headers: { 'content-type': 'application/json' }, ...(signal?{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}:{}), body: JSON.stringify({ ...body, test_person: owner }) });
    const mine = (await (await post('/v1/account/souls', {})).json()).souls ?? [];
    const key = mine.find((s) => s.soul.replace(/^soul-/, '') === said.soul.replace(/^s_/, ''))?.soul ?? said.soul;
    const named = await post('/v1/account/souls/profile', { soul: key, name });
    if (named.status !== 200) throw new Error(`${label}: naming the Soul ${name} answered ${named.status} ${await named.text().catch(() => "")} (a name is the world's once)`);
  }
  return seatOf({ label, folder, home, soul: said.soul, env, log, checkout, onSpawn, signal });
}

/** A seat over an already paired home. */
export function seatOf({ label, folder, home, soul, env, log, checkout=REPO_ROOT, onSpawn, signal }) {
  let body = null;
  const seat = {
    label, soul, home, folder,
    info: () => ({ id: label, soulId: soul, body, home }),
    /** The thin command with this seat's Soul; → its JSON answer (or {ok:false, raw}) */
    async cli(...words) {
      const t = Date.now();
      const r = await runNode([join(checkout,'v2/client/src/cli/souls.mjs'), ...words, '--soul', soul], { cwd: folder, env, timeoutMs: onSpawn ? 30000 : 120000, onSpawn, signal });
      const answer = lastJson(r.out) ?? { ok: false, raw: (r.out + r.err).slice(-500) };
      appendFileSync(log, JSON.stringify({ at: t, ms: Date.now() - t, words, answer }) + '\n');
      return answer;
    },
    /** Joins the world (`life:join`) and learns this seat's body id from its own copy (`status`'s `body`). */
    async join({ ms = 30_000 } = {}) {
      const a = await seat.cli('act', 'life:join', '--wait');
      const until = Date.now() + ms;
      while (!body && Date.now() < until) {
        body = (await seat.cli('status')).body ?? null;
        if (!body) await sleep(250);
      }
      return { answer: a, body };
    },
    /** The daemon's events after `since` (the gateway's answers among them), without taking them from `wait`. */
    events: (since = null) => seat.cli('events', ...(since != null ? ['--since', String(since)] : [])),
    /** Ends the daemon. */
    stop: () => seat.cli('quit').catch(() => null),
  };
  return seat;
}

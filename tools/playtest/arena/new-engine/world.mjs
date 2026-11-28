// A playtest world on the new engine (0.135 P1): a committed template (`worlds/templates/*.json`) exported to facts by
// `v2/tools/import-eden/export/export.ts --template`, seeded and served by `v2/tools/dev/run.sh --facts` (worldd,
// gatewayd, directoryd with the dev sign-in, the origin and the front door, all on loopback). Nothing starts
// apps/server. The old dev world (../provision.mjs) stays as it is until the old world is retired.
//
//   startWorld({ template, dir, port, history }) → { kind: 'v2', base, page, world, directory, gateway, dir, pid, facts }
//   stopWorld(world) stops run.sh, which stops everything it started.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { sleep } from '../../lib/clock.mjs';

export const RUN_SH = join(REPO_ROOT, 'v2/tools/dev/run.sh');
const EXPORT = join(REPO_ROOT, 'v2/tools/import-eden/export/export.ts');
/** run.sh serves its one world under this name (`/w/dev/`). */
export const WORLD = 'dev';

/** A finite startup child is registered before waiting and is cancellable as an owned process group. */
export async function runOwnedCommand(executable, args, { cwd = REPO_ROOT, env = process.env, onSpawn, onCommand, signal, timeoutMs = 180000, name = 'startup' } = {}) {
  signal?.throwIfAborted();
  const owner = onCommand?.({ phase: 'start', name, executable, args });
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let timer, escalation, closeDeadline, abort, failed, stdout = '', stderr = '';
  const kill = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  try {
    onSpawn?.(child, { transient: true, processGroup: true });
    return await new Promise((ok, no) => {
      const stop = error => { failed ??= error; kill('SIGTERM'); escalation ??= setTimeout(() => { kill('SIGKILL'); closeDeadline = setTimeout(() => no(Error('startup.child-did-not-exit')), 2000); }, 500); };
      abort = () => stop(signal.reason); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop(Error(`startup.${name}-timeout`)), timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) stop(Error('startup.output-limit')); });
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16 * 1024 * 1024) stop(Error('startup.output-limit')); });
      child.once('error', no);
      child.once('close', (code, sig) => failed ? no(failed) : code === 0 && !sig ? ok(stdout) : no(Error(`startup.${name}-exit: ${code}/${sig}: ${stderr.slice(-1000)}`)));
      if (signal?.aborted) abort();
    });
  } catch (error) { if (child.exitCode === null && child.signalCode === null) kill('SIGKILL'); throw error; }
  finally { clearTimeout(timer); clearTimeout(escalation); clearTimeout(closeDeadline); signal?.removeEventListener('abort', abort); onCommand?.({ phase: 'end', owner, name, ok: child.exitCode === 0 && child.signalCode === null }); }
}

/** The template's facts, exported once into `out` (the same template gives the same bytes); `map`, a world's map
 *  (`content/worlds/<world>/map.json`), names its things' entries and kinds. → the facts' path */
export function exportFacts(template, out, map = null, { checkout = REPO_ROOT, onCommand, timeoutMs = 180000, signal } = {}) {
  const t = resolve(checkout, template);
  if (!existsSync(t)) throw new Error(`no template ${template}`);
  mkdirSync(resolve(out, '..'), { recursive: true });
  signal?.throwIfAborted();
  const args = [join(checkout, 'v2/tools/import-eden/export/export.ts'), '--template', t, '--out', out, ...(map ? ['--map', resolve(checkout, map)] : [])];
  const owner = onCommand?.({ phase: 'start', name: 'export-facts', executable: process.execPath, args });
  try { execFileSync(process.execPath, args, { cwd: checkout, timeout: timeoutMs, stdio: ['ignore', 'ignore', 'pipe'] }); onCommand?.({ phase: 'end', owner, name: 'export-facts', ok: true }); }
  catch (error) { onCommand?.({ phase: 'end', owner, name: 'export-facts', ok: false }); throw error; }
  signal?.throwIfAborted();
  return out;
}

/** The world map soul.game's world of this template was imported with (`content/worlds/<world>/map.json`), or null:
 *  Eden's names its things' entries (a cafe's `cup_of_coffee`, not a nameless `cup_of_coffee_pack`, whose offers no
 *  client knows). Only Eden's for now: the other maps are not known to be how their worlds are made. */
export function mapFor(template, checkout = REPO_ROOT) {
  return basename(String(template ?? '')) === 'eden-2026.json' ? join(checkout, 'content/worlds/eden/map.json') : null;
}

const portFree = (port) => new Promise((ok) => { const s = createServer().once('error', () => ok(false)).listen(port, '127.0.0.1', () => s.close(() => ok(true))); });
/** A page port whose next three (directory, gateway, origin) are free too, from `from` upward. */
export async function freePorts(from = 7400 + Math.floor(Math.random() * 400) * 4, tries = 50) {
  for (let p = from, i = 0; i < tries && p <= 65532; i++, p += 4) {
    let all = true;
    for (let k = 0; k < 4 && all; k++) all = await portFree(p + k);
    if (all) return p;
  }
  throw new Error(`no four free ports from ${from}`);
}

/** The addresses run.sh gives its programs for page port `port` (run.sh's header). */
export function addresses(port, host = '127.0.0.1') {
  const base = `http://${host}:${port}`;
  return { base, page: `${base}/w/${WORLD}/`, directory: `http://127.0.0.1:${port + 1}`, gateway: `ws://127.0.0.1:${port + 2}/v2/ws`, origin: `http://127.0.0.1:${port + 3}` };
}

/** run.sh's arguments for a world folder, a page port and a facts file. */
export const runArgs = ({ dir, port, facts, bodies }) => ['--port', String(port), '--dir', dir, ...(facts ? ['--facts', facts] : []), ...(bodies ? ['--bodies', resolve(bodies)] : [])];

/** Starts run.sh and waits for its `ready` line. The world's folder is `dir` (run.sh's --dir, under an ignored .local/).
 *  `template` names the genesis; `facts` an already exported one; neither seeds N2's test world. */
export async function startWorld({ template = null, facts = null, bodies = null, dir, port = null, readyMs = 900_000, log = null, env = {}, history = false, checkout = REPO_ROOT, onSpawn, onCommand, signal } = {}) {
  if (!dir) throw new Error('startWorld: dir is required');
  const until = Date.now() + readyMs;
  const remaining = () => { signal?.throwIfAborted(); const ms = until - Date.now(); if (ms <= 0) throw Error('startWorld: startup timeout'); return ms; };
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  const seeded = existsSync(join(dir, 'world/world.json'));
  if (!facts && template && !seeded) {
    if (onSpawn) { facts = join(dir, 'genesis.facts.json'); await runOwnedCommand(process.execPath, [join(checkout, 'v2/tools/import-eden/export/export.ts'), '--template', resolve(checkout, template), '--out', facts, ...(mapFor(template, checkout) ? ['--map', mapFor(template, checkout)] : [])], { cwd: checkout, onSpawn, onCommand, signal, timeoutMs: remaining(), name: 'export-facts' }); }
    else facts = exportFacts(template, join(dir, 'genesis.facts.json'), mapFor(template, checkout));
  }
  port ??= await freePorts();
  const at = addresses(port);

  // `history`: the world ships its records to a folder store beside it (`WORLDD_STORE`, O9's `folder:`), so it writes
  // its public history (`history/`: the header, bundles and indices the page plays a past moment from)
  if (history) { mkdirSync(join(dir, 'store'), { recursive: true }); env = { WORLDD_STORE: `folder:${join(dir, 'store')}`, ...env }; }
  // A world's sockets live in its folder, and a socket's path is at most 104 bytes (macOS): a deep folder is run through
  // a short link to it in /tmp (run.sh keeps the link's path), and its data stays where it was asked to be.
  let runDir = dir, link = null;
  if (dir.length > 48) { link = join('/tmp', `souls-w-${randomBytes(4).toString('hex')}`); symlinkSync(dir, link); runDir = link; }
  // run.sh in its own process group: stopWorld signals the group, so nothing it started outlives the run.
  remaining();
  let child, out;
  try { out = openSync(log ?? join(dir, 'run.log'), 'a'); child = spawn('bash', [join(checkout, 'v2/tools/dev/run.sh'), ...runArgs({ dir: runDir, port, facts, bodies })], { cwd: checkout, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', out], detached: true }); } finally { if (out !== undefined) closeSync(out); }
  if (link) child.on('exit', () => { try { unlinkSync(link); } catch { /* gone */ } });
  let spawnError; child.once('error', e => { spawnError = e; });
  try { onSpawn?.(child, { processGroup: true }); } catch (error) { await stopWorld({ pid: child.pid, graceMs: 1000 }); throw error; }
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  const t0 = Date.now();
  while (!/^ready /m.test(text)) {
    if (spawnError) throw spawnError;
    if (signal?.aborted) { await stopWorld({ pid: child.pid }); signal.throwIfAborted(); }
    if (child.exitCode != null || child.signalCode != null) throw new Error(`run.sh ended (${child.exitCode}) before it was ready: ${tail(log ?? join(dir, 'run.log'))}`);
    if (Date.now() >= until) { await stopWorld({ pid: child.pid }); throw new Error(`run.sh was not ready in ${readyMs / 1000} s`); }
    await sleep(200);
  }
  return { kind: 'v2', ...at, world: WORLD, dir, pid: child.pid, child, facts, template, bootMs: Date.now() - t0 };
}

const tail = (f) => { try { return readFileSync(f, 'utf8').split('\n').slice(-4).join(' | '); } catch { return ''; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** SIGTERM run.sh's group (it stops what it started), SIGKILL after graceMs. */
export async function stopWorld({ pid, graceMs = 15_000 }) {
  if (!pid) return { stopped: false, reason: 'no pid' };
  const kill = (sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } };
  kill('SIGTERM');
  const end = Date.now() + graceMs;
  while (alive(pid) && Date.now() < end) await sleep(200);
  if (alive(pid)) { kill('SIGKILL'); await sleep(300); }
  return { stopped: !alive(pid) };
}

/** The world's bootstrap through the front door (as the new client reads it to pair): {ok, status, body}. Never throws. */
export async function healthz(world) {
  try {
    const r = await fetch(`${world.page}v1/bootstrap`, { signal: AbortSignal.timeout(10_000) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

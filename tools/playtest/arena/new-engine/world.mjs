// A playtest world on the new engine (0.135 P1): a committed template (`worlds/templates/*.json`) exported to facts by
// `v2/tools/import-eden/export/export.ts --template`, seeded and served by `v2/tools/dev/run.sh --facts` (worldd,
// gatewayd, directoryd with the dev sign-in, the origin and the front door, all on loopback). Nothing starts
// apps/server. The old dev world (../provision.mjs) stays as it is until the old world is retired.
//
//   startWorld({ template, dir, port, history }) → { kind: 'v2', base, page, world, directory, gateway, dir, pid, facts }
//   stopWorld(world) stops run.sh, which stops everything it started.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { sleep } from '../../lib/clock.mjs';

export const RUN_SH = join(REPO_ROOT, 'v2/tools/dev/run.sh');
const EXPORT = join(REPO_ROOT, 'v2/tools/import-eden/export/export.ts');
/** run.sh serves its one world under this name (`/w/dev/`). */
export const WORLD = 'dev';

/** The template's facts, exported once into `out` (the same template gives the same bytes). → the facts' path */
export function exportFacts(template, out) {
  const t = resolve(REPO_ROOT, template);
  if (!existsSync(t)) throw new Error(`no template ${template}`);
  mkdirSync(resolve(out, '..'), { recursive: true });
  execFileSync(process.execPath, [EXPORT, '--template', t, '--out', out], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
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
export const runArgs = ({ dir, port, facts }) => ['--port', String(port), '--dir', dir, ...(facts ? ['--facts', facts] : [])];

/** Starts run.sh and waits for its `ready` line. The world's folder is `dir` (run.sh's --dir, under an ignored .local/).
 *  `template` names the genesis; `facts` an already exported one; neither seeds N2's test world. */
export async function startWorld({ template = null, facts = null, dir, port = null, readyMs = 900_000, log = null, env = {}, history = false } = {}) {
  if (!dir) throw new Error('startWorld: dir is required');
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  const seeded = existsSync(join(dir, 'world/world.json'));
  if (!facts && template && !seeded) facts = exportFacts(template, join(dir, 'genesis.facts.json'));
  port ??= await freePorts();
  const at = addresses(port);
  const out = openSync(log ?? join(dir, 'run.log'), 'a');
  // `history`: the world ships its records to a folder store beside it (`WORLDD_STORE`, O9's `folder:`), so it writes
  // its public history (`history/`: the header, bundles and indices the page plays a past moment from)
  if (history) { mkdirSync(join(dir, 'store'), { recursive: true }); env = { WORLDD_STORE: `folder:${join(dir, 'store')}`, ...env }; }
  // A world's sockets live in its folder, and a socket's path is at most 104 bytes (macOS): a deep folder is run through
  // a short link to it in /tmp (run.sh keeps the link's path), and its data stays where it was asked to be.
  let runDir = dir, link = null;
  if (dir.length > 48) { link = join('/tmp', `souls-w-${randomBytes(4).toString('hex')}`); symlinkSync(dir, link); runDir = link; }
  // run.sh in its own process group: stopWorld signals the group, so nothing it started outlives the run.
  const child = spawn('bash', [RUN_SH, ...runArgs({ dir: runDir, port, facts })], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', out], detached: true });
  if (link) child.on('exit', () => { try { unlinkSync(link); } catch { /* gone */ } });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  const t0 = Date.now();
  while (!/^ready /m.test(text)) {
    if (child.exitCode != null) throw new Error(`run.sh ended (${child.exitCode}) before it was ready: ${tail(log ?? join(dir, 'run.log'))}`);
    if (Date.now() - t0 > readyMs) { await stopWorld({ pid: child.pid }); throw new Error(`run.sh was not ready in ${readyMs / 1000} s`); }
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

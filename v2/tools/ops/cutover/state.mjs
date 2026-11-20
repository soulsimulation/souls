// One cutover writer; durable phases describe partial operations, while canonical is the only admission truth.
import { constants, copyFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readWorldRoutes } from '../../origin/world-routes.mjs';
import { updateWorldRoute } from '../proxy/route-config.mjs';
import { bindingId, cutoverFence } from '../../../../tools/world-launcher/cutover.mjs';

const syncDir = (dir) => { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
export function record(file, row) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(file));
}
export function latest(file) {
  if (!existsSync(file)) return null;
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return rows.at(-1) ?? null;
}

/** Preserve the first backup. Without a journal, an unrelated/stale saved configuration cannot be trusted. */
export function prepareBackup({ current, backup, log }) {
  if (existsSync(backup)) {
    const previous = latest(log);
    if ((!previous || previous.step === 'back') && !readFileSync(backup).equals(readFileSync(current))) throw Error('cutover.backup-conflict: saved proxy differs before a fresh switch; operator review required');
    return;
  }
  copyFileSync(current, backup, constants.COPYFILE_EXCL);
  const fd = openSync(backup, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(backup));
}

/** Callbacks perform the existing precheck/news/proxy operations. Failed or interrupted routing never unfences. */
export async function transition({ command, dir, routesFile, slug, world, validate, news, prepare, switchRoute, backRoute, onRecord = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'transaction.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw Error('cutover.busy: transaction lock exists; verify the writer stopped before operator recovery'); throw e; }
  try {
    const log = join(dir, 'log.jsonl'), previous = latest(log);
    if (previous && (previous.slug !== slug || previous.world !== world)) throw Error('cutover.target-changed');
    const active = () => {
      const route = readWorldRoutes(routesFile)[slug];
      if (!route) throw Error('cutover.activation-unavailable');
      return route.canonical;
    };
    const note = (step) => { const row = { step, at: new Date().toISOString(), slug, world }; record(log, row); onRecord(row); };
    if (command === 'check') { await validate(); active(); return { step: previous?.step ?? 'old' }; }
    if (command === 'switch') {
      if (previous?.step === 'switched') {
        if (!active()) throw Error('cutover.activation-mismatch');
        return { step: 'switched', repeated: true };
      }
      if (previous?.step?.startsWith('back-')) throw Error('cutover.rollback-incomplete: finish back before switching');
      if (active() && (!previous || previous.step === 'back')) throw Error('cutover.activation-mismatch');
      await validate(); await prepare();
      note('switch');
      await updateWorldRoute(routesFile, slug, { canonical: true });
      note('fenced');
      try { await news(); await switchRoute(); }
      catch (e) { note('switch-failed'); throw Error(`cutover.switch-failed: old writes remain fenced; resume switch or run back (${e.message})`); }
      note('switched'); return { step: 'switched' };
    }
    if (command !== 'back') throw Error('cutover.command: check|switch|back');
    if (previous?.step === 'back') {
      if (active()) throw Error('cutover.activation-mismatch');
      return { step: 'back', repeated: true };
    }
    if (!previous) throw Error('cutover.not-switched');
    // Back also fences a switch interrupted immediately before canonical publication.
    await updateWorldRoute(routesFile, slug, { canonical: true });
    note('back-start');
    try { await backRoute(); } catch (e) { note('back-failed'); throw Error(`cutover.back-failed: old writes remain fenced; retry back (${e.message})`); }
    note('back-routed');
    await updateWorldRoute(routesFile, slug, { canonical: false });
    note('back'); return { step: 'back' };
  } finally { rmSync(lock, { recursive: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, script] = process.argv.slice(2), root = process.env.CUTOVER_ROOT || '';
  const slug = process.env.SLUG, world = process.env.WORLD;
  let binding, routesFile;
  const dir = `${root}/var/lib/souls/cutover`;
  const run = (action) => {
    const r = spawnSync('bash', [resolve(script), `__${action}`], { stdio: 'inherit', env: process.env });
    if (r.error || r.status !== 0) throw Error(`cutover.${action}-refused`);
  };
  const validate = async () => {
    run('check');
    const conf = readFileSync(`${root}/etc/sim-worlds/production.conf`, 'utf8');
    const port = /--port (\d+)/.exec(conf)?.[1];
    if (!port) throw Error('cutover.launcher-port-missing');
    const r = await fetch(`http://127.0.0.1:${port}/__sim/op/cutover`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const b = await r.json();
    if (r.status !== 200 || b.configured !== true || b.canonicalSlug !== slug || b.bindingId !== bindingId(binding)) throw Error('cutover.launcher-unprepared');
    if (b.active !== readWorldRoutes(routesFile)[slug]?.canonical) throw Error('cutover.activation-mismatch');
  };
  const prepare = () => prepareBackup({ current: `${root}/etc/caddy/sites/soul-game.caddy`, backup: `${root}/etc/caddy/soul-game.caddy.before-o19`, log: join(dir, 'log.jsonl') });
  try {
    try { binding = JSON.parse(readFileSync(process.env.SOULS_CUTOVER_BINDING || `${root}/etc/souls/cutover-binding.json`, 'utf8')); }
    catch { throw Error('cutover.binding-unavailable'); }
    cutoverFence({ binding }); // Validate the operator's complete binding before asking the launcher to confirm it.
    if (binding.canonicalSlug !== slug) throw Error('cutover.binding-target-mismatch');
    routesFile = binding.routesFile;
    const result = await transition({ command, dir, routesFile, slug, world, validate, prepare, news: () => run('news'), switchRoute: () => run('switch-route'), backRoute: () => run('back-route') });
    console.log(`cutover: ${result.step}${result.repeated ? ' (safe repeat; nothing changed)' : ''}`);
    if (command === 'back' && !result.repeated) run('count');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

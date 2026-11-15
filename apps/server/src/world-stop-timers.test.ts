// #2444 (review of PR #2445): a world stopped inside a shard leaves nothing running in the program it shared. Every interval
// and every timeout of 5 s or more that its start set is cleared by its stop (startWorld with `exit`, as shard.mjs runs it).
// A timer left behind keeps the stopped world's host, database and Souls alive and acting in a program that runs on.
// One child process, so the timer hooks end with it.
import test from 'node:test'; import assert from 'node:assert/strict'; import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { testPort } from '../test/test-port.ts';

const here = (f: string) => new URL(f, import.meta.url).pathname;
const CHILD = `
const timers = [], si = globalThis.setInterval, st = globalThis.setTimeout;
let tracking = false;
const where = () => new Error().stack.split('\\n').slice(2, 4).map((s) => s.trim()).join(' < ');
globalThis.setInterval = (...a) => { const t = si(...a); if (tracking) timers.push({ t, kind: 'interval', ms: a[1], at: where() }); return t; };
globalThis.setTimeout = (...a) => { const t = st(...a); if (tracking && (a[1] ?? 0) >= 5000) timers.push({ t, kind: 'timeout', ms: a[1], at: where() }); return t; };
const { loadConfig } = await import(${JSON.stringify(here('./config.ts'))});
const { startWorld } = await import(${JSON.stringify(here('./world-main.ts'))});
tracking = true;
let exited = null, ended = null;
const boot = process.argv[2] === 'boot';
// 'boot': a stop that arrives while the boot waits for its initial projection ends the boot (its failure path)
const interrupt = boot ? si(() => process.emit('SIGTERM'), 2) : null;
const started = startWorld(loadConfig(JSON.parse(process.argv[1])), { exit: (code) => { exited = code; }, signals: false });
if (boot) { ended = await started.then(() => 'served', (e) => e.message); clearInterval(interrupt); }
else { const w = await started; await w.listening; await new Promise((r) => st(r, 1500)); await w.shutdown('SIGTERM'); }
tracking = false;
await new Promise((r) => st(r, 100));
console.log('RESULT ' + JSON.stringify({ exited, ended, set: timers.length, left: timers.filter((x) => !x.t._destroyed).map(({ kind, ms, at }) => ({ kind, ms, at })) }));
process.exit(0);
`;

async function run(t: { after(f: () => void): void }, mode: 'stop' | 'boot') {
  const root = mkdtempSync(join(tmpdir(), 'world-stop-timers-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await testPort();
  // a Mars world with central minds and a living day: no Eden core, so its brain is not quiesced by the Eden drain
  const env = { WORLD_KEY: 'timers', ENGINE: 'mars', MIND_DRIVER: 'central', WORLD_ID: 'stop-timers', WORLD_PATH: '/w/stop-timers', ENABLE_LIVING_WORLD: '1',
    DATA_DIR: join(root, 'w'), PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://localhost:${port}`, BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0',
    SEED_NATIVES: '0', DEV_AUTH: '1', ARCHIVE_TAKES: '0' };
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify(env), mode], { cwd: root, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.once('exit', r));
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result (exit ${code}): ${err.slice(-2000)}`);
  return { ...JSON.parse(line.slice(7)), out: out + err };
}

test('#2444: a world stopped in a shard clears every timer it set (hub, Souls, brain, clock, portraits, refusals)', { timeout: 180_000 }, async (t) => {
  const r = await run(t, 'stop');
  assert.equal(r.exited, 0, 'the world ended through its exit, not the program');
  assert.ok(r.set >= 10, `its start set its timers (${r.set})`);
  assert.deepEqual(r.left, [], 'none is left running');
});

test('#2444 review: a world whose boot fails in a shard clears every timer its boot set', { timeout: 180_000 }, async (t) => {
  const r = await run(t, 'boot');
  assert.match(r.out, /boot interrupted: SIGTERM/, 'the boot was ended while it waited for its projection');
  assert.equal(r.exited, 0, 'the world ended through its exit');
  assert.equal(r.ended, 'world.boot.ended');
  assert.ok(r.set >= 5, `its boot set timers (${r.set})`);
  assert.deepEqual(r.left, [], 'none is left running');
});

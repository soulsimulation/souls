// Shards (#2389 A3): a world is a function. Two worlds started by startWorld in one Node process, each from its own config
// (its own data dir, port, id, seed, path and switches), with no world setting in the process environment. Each serves its own
// world with its own state hash, and neither sees the other's config. One child process, so the process-wide parts (signal
// handlers, timers) end with it.
import test from 'node:test'; import assert from 'node:assert/strict'; import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { testPort } from '../test/test-port.ts';
import { Db } from './db.ts';
import { GodMode } from './god/god.ts';

const here = (f: string) => new URL(f, import.meta.url).pathname;
const CHILD = `
import { loadConfig } from ${JSON.stringify(here('./config.ts'))};
import { startWorld } from ${JSON.stringify(here('./world-main.ts'))};
import { moderationFor } from ${JSON.stringify(here('./moderation/store.ts'))};
const envs = JSON.parse(process.argv[1]), started = [];
for (const env of envs) { const w = await startWorld(loadConfig(env)); await w.listening; started.push(w); }
const out = [];
for (const w of started) {
  const base = 'http://127.0.0.1:' + w.config.port;
  const health = await (await fetch(base + '/healthz')).json(), cfg = await (await fetch(base + '/v1/config')).json();
  const nav = (await fetch(base + '/v1/debug/nav')).status;   // mounted only where the world's own env has SIM_NAV_DEBUG
  out.push({ worldId: health.worldId, worldPath: cfg.worldPath, nav, dataDir: w.config.dataDir, own: w.host.config === w.config,
    hash: w.host.engine.stateHash(), db: w.db.path, siteLog: moderationFor(w.db.db, w.host.worldId).siteLog });   // the store http.ts made
}
console.log('RESULT ' + JSON.stringify({ out, leaked: ['WORLD_ID', 'WORLD_PATH', 'SIM_NAV_DEBUG', 'DATA_DIR', 'PORT'].filter((k) => k in process.env) }));
process.exit(0);
`;

test('#2389 A3: two worlds in one process, each from its own config, serve their own state', { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'world-main-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const world = (n: 'a' | 'b', port: number) => ({ WORLD_KEY: 'toy', ENGINE: 'toy', WORLD_ID: `shard-${n}`, WORLD_SEED: `seed-${n}`, WORLD_PATH: `/w/shard-${n}`,
    ...(n === 'a' ? { SIM_NAV_DEBUG: '1' } : {}), SIM_MODERATION_SITE_LOG: join(root, n, 'site.jsonl'),
    DATA_DIR: join(root, n), PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://localhost:${port}`, BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0',
    SEED_NATIVES: '0', SIM_WATCHDOG: '0', DEV_AUTH: '1' });
  const a = world('a', await testPort()), b = world('b', await testPort());
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify([a, b])], { cwd: root, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let logs = ''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  const code = await new Promise<number | null>((r) => child.once('exit', r));
  assert.equal(code, 0, logs);
  const line = logs.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, logs);
  const { out, leaked } = JSON.parse(line.slice(7)) as { out: { worldId: string; worldPath: string; nav: number; dataDir: string; own: boolean; hash: string; db: string; siteLog: string }[]; leaked: string[] };
  assert.deepEqual(leaked, [], 'no world setting comes from the process environment');
  // its id, path and data dir, and an env switch read after boot (SIM_NAV_DEBUG, http.ts): A's is on, B's is off
  assert.deepEqual(out.map((w) => [w.worldId, w.worldPath, w.nav, w.dataDir, w.own]),
    [['shard-a', '/w/shard-a', 200, a.DATA_DIR, true], ['shard-b', '/w/shard-b', 404, b.DATA_DIR, true]]);
  assert.ok(out[0].db.startsWith(a.DATA_DIR) && out[1].db.startsWith(b.DATA_DIR), 'each world opens its own database');
  assert.deepEqual(out.map((w) => w.siteLog), [a.SIM_MODERATION_SITE_LOG, b.SIM_MODERATION_SITE_LOG], 'each world keeps its own moderation site log');
  assert.match(out[0].hash, /\S/); assert.notEqual(out[0].hash, out[1].hash, 'each world has its own state hash');
});

test('#2389 A3: two GodModes in one process hold their own production clock rule (god.ts, world-env.ts)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'world-clock-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  // world-env.ts imports the module-level config, which makes its default ./data: import it from the temp root
  const cwd = process.cwd(); process.chdir(root); const { envView } = await import('./god/world-env.ts'); process.chdir(cwd);
  const god = (n: string, env: Record<string, string>) => { const db = new Db(join(root, `${n}.db`)); t.after(() => db.close());
    return new GodMode(db, { worldId: `clock-${n}`, ownerId: 'dev:admin', tick: () => 0, emit() {}, env }); };
  const prod = god('prod', { SIM_STAGE: 'production', SIM_REAL_TIME: '1' }), dev = god('dev', { SIM_STAGE: 'staging', SIM_REAL_TIME: '1' });
  const sneak = (g: GodMode) => g.act({ ops: [{ op: 'world', state: { time: { clock: 'accelerated' } } }] } as never, 'sneak') as { accepted: boolean; failures?: { code: string }[] };
  const p = sneak(prod), d = sneak(dev);
  assert.equal(p.accepted, false); assert.equal(p.failures?.[0]?.code, 'time.accelerated-production');
  assert.equal(d.accepted, true, JSON.stringify(d));
  assert.equal(envView({ engine: { world: {} } } as never, prod).time.mode, 'real');
  assert.equal(envView({ engine: { world: {} } } as never, god('off', { SIM_REAL_TIME: '0' })).time.mode, 'accelerated');
});

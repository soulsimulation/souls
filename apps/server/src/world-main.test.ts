// Shards (#2389 A3, #2416 A3): a world is a function. Two worlds started by startWorld in one Node process, each from its own config
// (its own data dir, port, id, seed, path and switches), with no world setting in the process environment. Each serves its own
// world with its own state hash, and neither sees the other's config. One child process, so the process-wide parts (signal
// handlers, timers) end with it.
import test from 'node:test'; import assert from 'node:assert/strict'; import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Hono } from 'hono';
import { testPort } from '../test/test-port.ts';
import { fixture, factory } from '../test/native-owner-fixture.ts';
import { Db } from './db.ts';
import { GodMode } from './god/god.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { installEngineBridge } from './god/engine-bridge.ts';
import { GroundHost } from './god/ground-host.ts';
import { closeContextViews, mountContextViews } from './god/context-views.ts';
import { worldDayOf } from './god/poster-boards.ts';

const here = (f: string) => new URL(f, import.meta.url).pathname;
const CHILD = `
import { loadConfig } from ${JSON.stringify(here('./config.ts'))};
import { startWorld } from ${JSON.stringify(here('./world-main.ts'))};
import { moderationFor } from ${JSON.stringify(here('./moderation/store.ts'))};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const envs = JSON.parse(process.argv[1]), started = [];
for (const env of envs) { const w = await startWorld(loadConfig(env)); await w.listening; started.push(w); }
// #2416 A2: let each world's monitor sample and each world's watchdog write its own live.json
const live = (w) => { try { return JSON.parse(readFileSync(join(w.config.dataDir, 'live.json'), 'utf8')); } catch { return null; } };
for (let i = 0; i < 100 && !started.every((w) => live(w)?.phase === 'serving' && live(w)?.level === (w.config.env.SIM_LOAD_DRILL_LEVEL ?? 'green')); i++) await new Promise((r) => setTimeout(r, 100));
const out = [];
for (const w of started) {
  const base = 'http://127.0.0.1:' + w.config.port;
  const health = await (await fetch(base + '/healthz')).json(), cfg = await (await fetch(base + '/v1/config')).json();
  const nav = (await fetch(base + '/v1/debug/nav')).status;   // mounted only where the world's own env has SIM_NAV_DEBUG
  out.push({ worldId: health.worldId, worldPath: cfg.worldPath, nav, dataDir: w.config.dataDir, own: w.host.config === w.config,
    hash: w.host.engine.stateHash(), db: w.db.path, siteLog: moderationFor(w.db.db, w.host.worldId).siteLog,   // the store http.ts made
    level: health.load?.level, live: live(w) && { phase: live(w).phase, level: live(w).level }, shared: started.filter((o) => o.load.shared === w.load.shared || o.load.api === w.load.api).length,
    hostSlots: w.host.stepSlots === w.load.shared && w.host.bootProgress === w.load.boot });
}
console.log('RESULT ' + JSON.stringify({ out, leaked: ['WORLD_ID', 'WORLD_PATH', 'SIM_NAV_DEBUG', 'DATA_DIR', 'PORT'].filter((k) => k in process.env) }));
process.exit(0);
`;

test('#2389 A3: two worlds in one process, each from its own config, serve their own state', { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'world-main-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const world = (n: 'a' | 'b', port: number) => ({ WORLD_KEY: 'toy', ENGINE: 'toy', WORLD_ID: `shard-${n}`, WORLD_SEED: `seed-${n}`, WORLD_PATH: `/w/shard-${n}`,
    ...(n === 'a' ? { SIM_NAV_DEBUG: '1' } : {}), SIM_LOAD_DRILL_LEVEL: n === 'a' ? 'red' : 'amber', SIM_MODERATION_SITE_LOG: join(root, n, 'site.jsonl'),
    DATA_DIR: join(root, n), PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://localhost:${port}`, BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0',
    SEED_NATIVES: '0', DEV_AUTH: '1' });   // each world runs its own watchdog thread (#2416 A2)
  const a = world('a', await testPort()), b = world('b', await testPort());
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify([a, b])], { cwd: root, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let logs = ''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  const code = await new Promise<number | null>((r) => child.once('exit', r));
  assert.equal(code, 0, logs);
  const line = logs.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, logs);
  const { out, leaked } = JSON.parse(line.slice(7)) as { out: { worldId: string; worldPath: string; nav: number; dataDir: string; own: boolean; hash: string; db: string; siteLog: string;
    level: string; live: { phase: string; level: string } | null; shared: number; hostSlots: boolean }[]; leaked: string[] };
  assert.deepEqual(leaked, [], 'no world setting comes from the process environment');
  // its id, path and data dir, and an env switch read after boot (SIM_NAV_DEBUG, http.ts): A's is on, B's is off
  assert.deepEqual(out.map((w) => [w.worldId, w.worldPath, w.nav, w.dataDir, w.own]),
    [['shard-a', '/w/shard-a', 200, a.DATA_DIR, true], ['shard-b', '/w/shard-b', 404, b.DATA_DIR, true]]);
  assert.ok(out[0].db.startsWith(a.DATA_DIR) && out[1].db.startsWith(b.DATA_DIR), 'each world opens its own database');
  assert.deepEqual(out.map((w) => w.siteLog), [a.SIM_MODERATION_SITE_LOG, b.SIM_MODERATION_SITE_LOG], 'each world keeps its own moderation site log');
  assert.match(out[0].hash, /\S/); assert.notEqual(out[0].hash, out[1].hash, 'each world has its own state hash');
  // #2416 A2: A holds red and B amber (a load drill in each world's own env); each world's health check, live.json and watchdog say its own
  assert.deepEqual(out.map((w) => [w.level, w.live]), [['red', { phase: 'serving', level: 'red' }], ['amber', { phase: 'serving', level: 'amber' }]], logs);
  assert.deepEqual(out.map((w) => [w.shared, w.hostSlots]), [[1, true], [1, true]], 'each world has its own load gauges, API times and boot progress');
});

// #2416 A3: two Mars god worlds in one process. A god edit in A widens A's walk reach (its ground grows past ±500 m) and
// leaves B's as it was; each world's day is its own; the state hashes stay independent.
test('#2416 A3: a god edit in one world does not change the other\'s walk reach; each world keeps its own day', { timeout: 120_000 }, async (t) => {
  const world = () => {
    const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
    const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit() {} });
    new GroundHost(w.db, w.host, god);
    const edge = new EdgeLedger(w.host, w.db), bridge = installEngineBridge({ host: w.host, god, edge, log() {}, worldClock: false, worldLore: false });
    t.after(() => { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); });
    const settle = async (n = 4) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
    return { ...w, god, bridge, settle, engine: w.host.engine as unknown as { registry: Map<string, { schema: { safeParse(p: unknown): { success: boolean } } }>; stateHash(): string } };
  };
  const A = world(), B = world(); await A.settle(); await B.settle();
  const reaches = (w: typeof A, x: number) => w.engine.registry.get('walk_to')!.schema.safeParse({ actor: 'h', x, z: 0 }).success;
  assert.deepEqual([reaches(A, 700), reaches(B, 700)], [false, false], 'both start within ±500 m');
  const groundOf = (w: typeof A) => (w.engine as unknown as { world: { groundV1?: { recipeHash: string } } }).world.groundV1?.recipeHash, groundB = groundOf(B);
  const r = A.god.act({ ops: [{ op: 'expand', extent: 1600 }] }) as { accepted: boolean }; assert.equal(r.accepted, true, JSON.stringify(r));
  await A.settle(8); await B.settle(8);
  assert.deepEqual([reaches(A, 700), reaches(B, 700)], [true, false], 'the edit widened A\'s reach only');
  assert.equal(groundOf(B), groundB, 'B\'s ground is untouched by A\'s edit'); assert.notEqual(groundOf(A), groundB);
  assert.notEqual(A.engine.stateHash(), B.engine.stateHash());
  // each world's day: A's clock is on day 10, B's on day 3 (a short day of 1500 ticks)
  const DAY = 1500, onDay = (w: typeof A, d: number) => Object.defineProperty(w.host, 'living', { configurable: true,
    value: { ...((w.host as unknown as { living?: object }).living ?? {}), origin: w.host.engine.world.tick - d * DAY - 20, dayTicks: DAY } });
  onDay(A, 10); onDay(B, 3);
  const dayOf = (w: typeof A) => (w.bridge as unknown as { perceive: { h: { worldDay(): number } } }).perceive.h.worldDay();
  assert.deepEqual([worldDayOf(A.host), worldDayOf(B.host), dayOf(A), dayOf(B)], [10, 3, 10, 3], 'each world reads its own day');
});

// #2416 A3: each world's context views are its own. A god edit in A re-keys A's view and leaves B's; closing A's views
// leaves B's serving.
test('#2416 A3: a god edit and a close in one world leave the other\'s context views', async (t) => {
  const world = (n: string) => {
    const db = new Db(':memory:'), dir = mkdtempSync(join(tmpdir(), `context-${n}-`)); t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    const god = new GodMode(db, { worldId: `context-${n}`, ownerId: null, tick: () => 1, emit() {}, assetDir: dir });
    god.act({ ops: [{ op: 'place', def: 'core/bench@1', name: 'seat', p: [0, 0], about: { title: 'Seat', viewpoint: { eye: [2, 2, 3], at: [0, 1, 0] } } }] });
    const app = new Hono(), ref = god.model.get('seat')!.id;
    const views = mountContextViews(app, { god, edge: { places: { byId: new Map() }, knowledge: { knows: () => true } } as never,
      contextReady: () => true, waitForContext: async () => {}, levelAt: () => 0, worldUrl: 'http://127.0.0.1:5980', soul: () => null, limit() {},
      renderer: async () => ({ png: new Uint8Array([1]) }) });
    const view = async () => { const r = await app.request('/v1/world/context/views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs: [ref] }) });
      assert.equal(r.status, 200); await views.cache.settled(); return ((await r.json()) as { views: { key: string; revision: number }[] }).views[0]; };
    return { god, ref, views, view };
  };
  // the views share the host render slot: own a lock directory, never contend with a running world (context-views.test.ts)
  const lockDir = mkdtempSync(join(tmpdir(), 'context-lock-')), previous = process.env.SIM_RENDER_LOCK_DIR; process.env.SIM_RENDER_LOCK_DIR = lockDir;
  t.after(() => { if (previous === undefined) delete process.env.SIM_RENDER_LOCK_DIR; else process.env.SIM_RENDER_LOCK_DIR = previous; rmSync(lockDir, { recursive: true, force: true }); });
  const A = world('a'), B = world('b');
  const a0 = await A.view(), b0 = await B.view();
  A.god.act({ ops: [{ op: 'set', id: A.ref, about: { ...A.god.model.get(A.ref)!.about, viewpoint: { eye: [3, 2, 3], at: [0, 1, 0] } } }] });
  await A.views.cache.settled();
  const a1 = await A.view(), b1 = await B.view();
  assert.notEqual(a1.key, a0.key, 'A\'s camera edit re-keys A\'s view');
  const kr = (v: { key: string; revision: number }) => [v.key, v.revision];
  assert.deepEqual(kr(b1), kr(b0), 'B\'s view is unchanged');
  await closeContextViews(A.views);
  assert.deepEqual(kr(await B.view()), kr(b0), 'B still serves after A\'s views close');
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

// #2458 A2: a recovery that outlasts the hang limit, under the launcher's ChildPool. A real world (apps/server main.ts,
// fake minds, edge Souls (one native), Eden core with its durable clock) meets an engine error at tick N on every boot that steps it
// (fault-inject throw-at), and its recovery replays from the last snapshot at a busy world's cost per tick (replayMs), so
// it holds the main thread past the 2 s hang limit and the watchdog kills it. Before #2458 that was a loop: every restart
// met the same error, replayed the same stretch and was killed again (10 kills, then held by the breaker). Now the restart
// makes progress: the kill was inside a recovery, so it contains the same error in place, named, and serves on past N.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as request_ } from 'node:http';
import { ChildPool } from './children.mjs';
import { testPort } from '../lib/test-port.ts';

const P0 = await testPort(6), root = new URL('../../', import.meta.url).pathname, main = new URL('../../apps/server/src/main.ts', import.meta.url).pathname;
const WORLD = 'recovery-loop-20261115';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a restart after a killed recovery makes progress: it recovers from its boot and is not killed again', { timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-loop-')), dataDir = join(dir, 'data'), logDir = join(dir, 'logs');
  const env = (port) => ({ PATH: process.env.PATH, DATA_DIR: dataDir, WORLD_KEY: 'eden', WORLD_ID: WORLD, WORLD_PATH: '/w/eden', ENGINE: 'mars', ENABLE_EDEN_CORE: '1', ENABLE_EDEN_LIFE: '1',
    ENABLE_CLOSED_HUMAN_GOALS: '1', ENABLE_REGISTERED_HUMAN_ACTIVITIES: '1', ENABLE_LIVING_WORLD: '1', SEED_NATIVES: '1', DEV_AUTH: '1', WORLD_OWNER_ID: 'dev:admin', MIND_DRIVER: 'edge', BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0', ARCHIVE_TAKES: '0', PORT: String(port), HOST: '127.0.0.1',
    PUBLIC_URL: `http://127.0.0.1:${port}/w/eden`, BUILD_ID: 'recovery-loop', SIM_FAULT_INJECT: '1', NODE_OPTIONS: '--max-old-space-size=768', SIM_HANG_KILL_MS: '2000', SIM_STALL_STACK_MS: '1000',
    // only the stop's snapshot: the recovery's baseline stays where the test put it
    SNAPSHOT_EVERY_TICKS: '1000000', SNAPSHOT_DEBT_MS: '0' });
  const pool = new ChildPool({ root, range: [P0, P0 + 5], logDir, publicOrigin: 'http://127.0.0.1', healthPath: () => '/w/eden/healthz', guard: { breakerN: 10, backoffCapMs: 1000 },
    command: (w, port) => ({ cmd: process.execPath, args: [main], env: env(port) }) });
  const world = { slug: 'eden', dataDir };
  t.after(async () => { await pool.closeAll(); rmSync(dir, { recursive: true, force: true }); });
  const log = () => readFileSync(join(logDir, 'eden.log'), 'utf8');
  const base = () => `http://127.0.0.1:${pool.status('eden').port}`;
  const health = async () => (await fetch(`${base()}/w/eden/healthz`, { signal: AbortSignal.timeout(2000) })).json();
  const fault = (q) => new Promise((yes, no) => request_(`${base()}/__sim/fault?${q}`, { method: 'POST', agent: false }, (r) => { r.resume(); r.on('end', () => yes(r.statusCode)); }).on('error', no).end());
  const say = (m) => t.diagnostic(m);

  // the baseline: a stop's snapshot, then ~300 ticks of history past it
  await pool.ensure(world); await wait(1000); await pool.stop('eden'); await pool.ensure(world);
  const from = (await health()).tick;
  for (let i = 0; i < 400 && (await health()).tick < from + 300; i++) await wait(100);
  const at = (await health()).tick + 10;
  assert.equal(await fault(`kind=throw-at&tick=${at}&replayMs=12`), 202);

  // the first recovery replays ~300 ticks at 12 ms: past the 2 s limit, so the watchdog kills it and the launcher restarts it
  let restarts = 0, lastPid = pool.status('eden').pid, beyond = false;
  for (let i = 0; i < 1200 && !beyond; i++) {
    const s = pool.status('eden');
    if (s.pid && s.pid !== lastPid) { restarts++; lastPid = s.pid; }
    if (s.status === 'running') try { const h = await health(); beyond = h.tick > at + 200; } catch { /* restarting */ }
    await wait(100);
  }
  const kills = log().match(/world\.killed\.hang/g)?.length ?? 0, holds = [...log().matchAll(/\[world\] recovery hold (\d+) ms at tick (\d+): (\d+) replays \(([^)]*) ticks\)/g)].map((m) => `${m[1]} ms at ${m[2]} (${m[4]} ticks)`);
  say(`throw at tick ${at}: ${kills} hang kills, ${restarts} restarts; recovery holds: ${holds.join('; ') || 'none'}; ${log().match(/world\.recovery-quarantined[^\n]*/)?.[0] ?? 'no quarantine'}`);
  assert.ok(beyond, `the world serves past tick ${at} (status ${pool.status('eden').status})`);
  assert.equal(kills, 1, 'killed once, by the first long recovery, and not again');
  assert.ok(holds.length >= 1 && Number(holds.at(-1).split(' ')[0]) < 2000, `the restart's recovery is short: ${holds.at(-1)}`);
  assert.match(holds.at(-1), /\(none ticks\)/, 'and replays nothing');
  assert.match(log(), /\[world\] world\.recovery-quarantined: a recovery ended the last process at tick \d+ \(1 in a row\)/, 'the restart names why it contains the fault instead of replaying it');
});

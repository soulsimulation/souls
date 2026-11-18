// #2235 A8: no world stays unreachable while it catches up. The real main.ts on the Toy engine: it runs, stops (its wall
// anchor saved), and the anchor is moved back as if the process had been gone for a while. On the next boot the port
// opens while the missed ticks are still being ticked: reads are answered at once with the ticks still owed (header
// x-sim-catching-up, /healthz catchingUp.ticksOwed), and writes wait and land after the catch-up.
import test from 'node:test'; import assert from 'node:assert/strict'; import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { testPort } from '../test/test-port.ts';

const PORT = await testPort(), base = `http://127.0.0.1:${PORT}`;
function boot(t: test.TestContext, data: string) {
  const logs: string[] = [];
  const child = spawn(process.execPath, [new URL('./main.ts', import.meta.url).pathname], { env: { PATH: process.env.PATH, DATA_DIR: data, WORLD_ID: 'catch-up-fixture', WORLD_KEY: 'toy', ENGINE: 'toy', SEED_NATIVES: '0', BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0', PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => logs.push(String(d))); child.stderr!.on('data', (d) => logs.push(String(d)));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, exited, logs: () => logs.join('') };
}
async function health(w: ReturnType<typeof boot>) {
  for (let i = 0; i < 1500; i++) {
    if (w.child.exitCode !== null) throw Error('startup failed: ' + w.logs());
    try { const r = await fetch(`${base}/healthz`); if (r.ok) return { header: r.headers.get('x-sim-catching-up'), body: await r.json() as { tick: number; catchingUp?: { ticksOwed: number } } }; } catch { /* not open yet */ }
    await delay(10);
  }
  throw Error('never answered: ' + w.logs());
}

/** A world that ran, stopped, and was then gone for `awayMs`: the anchor its stop saved is moved back by that much. */
async function away(t: test.TestContext, awayMs: number) {
  const data = mkdtempSync(join(tmpdir(), 'catch-up-answers-')); t.after(() => rmSync(data, { recursive: true, force: true }));
  const first = boot(t, data); await health(first); await delay(500);
  first.child.kill('SIGTERM'); assert.equal(await first.exited, 0, first.logs());
  const file = join(data, 'clock-wall.json'), anchor = JSON.parse(readFileSync(file, 'utf8')) as { wall: number; tick: number };
  writeFileSync(file, JSON.stringify({ ...anchor, wall: anchor.wall - awayMs }) + '\n');
  return { data, anchor };
}
const post = (text: string, signal?: AbortSignal) => fetch(`${base}/v1/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal });
const feedback = (data: string) => { const dir = join(data, 'feedback'); try { return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map((l) => JSON.parse(l) as { text: string; serverTick: number }); } catch { return []; } };

test('a world catching up a gap answers reads with the ticks it owes, and its writes land once each, after the catch-up', { timeout: 120_000 }, async (t) => {
  const awayMs = 2 * 3_600_000, { data, anchor } = await away(t, awayMs);
  const w = boot(t, data);
  const read = await health(w);
  assert.ok(read.body.catchingUp && read.body.catchingUp.ticksOwed > 0, `the first read is answered during the catch-up: ${JSON.stringify(read.body)}`);
  assert.ok(Number(read.header) > 0, 'with the ticks still owed in x-sim-catching-up');
  assert.ok(read.body.tick < anchor.tick + awayMs / 50, 'and the world is still behind the wall');
  // two writes sent during the catch-up: both wait, then each lands once, after it. The server dispatches held writes in
  // the order they arrive, but two requests on separate connections may arrive in either order however far apart they
  // are sent (it failed once in the merge group with 20 ms), so the test checks the set, not the order.
  const a = post('first, during the catch-up'); await delay(20); const b = post('second, during the catch-up');
  const again = await health(w);
  assert.ok(again.body.catchingUp, `still catching up while the writes wait: ${JSON.stringify(again.body)}`);
  assert.equal((await a).status, 201); assert.equal((await b).status, 201);
  const caught = /\[clock\] caught up (\d+) ticks .* now tick (\d+)/.exec(w.logs());
  assert.ok(caught, `the catch-up finished before the writes were answered: ${w.logs()}`);
  const done = Number(caught[2]);
  const entries = feedback(data);
  assert.deepEqual(entries.map((e) => e.text).sort(), ['first, during the catch-up', 'second, during the catch-up'], `each write once: ${JSON.stringify(entries)}`);
  for (const e of entries) assert.ok(e.serverTick >= done, `${e.text}: landed at tick ${e.serverTick}, after the catch-up ended at ${done}`);
  const after = await health(w);
  assert.equal(after.body.catchingUp, undefined, 'caught up: no longer reported');
  t.diagnostic(JSON.stringify({ owedAtFirstRead: read.body.catchingUp.ticksOwed, ran: Number(caught[1]), line: caught[0] }));
  w.child.kill('SIGTERM'); assert.equal(await w.exited, 0);
});

test('a held write whose client gave up is dropped; a stop during the catch-up answers the held writes 503', { timeout: 120_000 }, async (t) => {
  const { data } = await away(t, 6 * 3_600_000);
  const w = boot(t, data);
  assert.ok((await health(w)).body.catchingUp, 'catching up');
  await post('the client gave up', AbortSignal.timeout(200)).then(() => assert.fail('answered while held'), () => {});
  const held = post('held at the stop');
  await delay(200);
  assert.ok((await health(w)).body.catchingUp, 'still catching up at the stop');
  w.child.kill('SIGTERM');
  const r = await held;
  assert.equal(r.status, 503, 'the held write is answered, not cut'); assert.equal(r.headers.get('retry-after'), '5');
  assert.equal(await w.exited, 0, w.logs());
  assert.match(w.logs(), /1 of 1 write request\(s\) in flight answered/, 'the drain did not wait out its time');
  assert.deepEqual(feedback(data), [], 'neither write was applied');
});

// #1750 A4: the bookkeeping routes (ack, result, a receipt read) and a due long-poll return answer within 50 ms at p99
// while the world's thread is held busy for 5 s: ticks every 50 ms and 24 Souls each sending acts back to back through
// admission. The server runs in a child process (test/c0-under-load-server.ts); times are measured from here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Agent, request} from 'node:http';

const agent = new Agent({keepAlive: true});
function call(port: number, method: string, path: string, body?: string): Promise<{status: number; ms: number}> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = request({host: '127.0.0.1', port, method, path, agent, headers: {authorization: 'Bearer sim_probe', ...(body ? {'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body))} : {})}}, res => {
      res.resume(); res.on('end', () => resolve({status: res.statusCode ?? 0, ms: performance.now() - t0}));
    });
    req.on('error', reject); req.end(body);
  });
}
const p99 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.99 * s.length) - 1)]; };

test('A4: ack, result, receipt reads and due long-poll returns answer within 50 ms (p99) while the thread is held busy for 5 s', {timeout: 60_000}, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../test/c0-under-load-server.ts', import.meta.url))], {stdio: ['ignore', 'pipe', 'inherit']});
  try {
    const port = await new Promise<number>((resolve, reject) => { child.stdout.on('data', d => { const m = /port (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.once('exit', c => reject(new Error(`server exited ${c}`))); });
    const from = performance.now() + 500, until = from + 5000, acts: number[] = [], c0: Record<string, number[]> = {receipt: [], ack: [], result: [], listenLate: []};
    const soul = async (i: number) => { while (performance.now() < until) { const r = await new Promise<{status: number; ms: number}>((resolve, reject) => {
      const body = '{"capability":"walk:x"}', t0 = performance.now();
      const req = request({host: '127.0.0.1', port, method: 'POST', path: '/v1/edge/act', agent, headers: {authorization: `Bearer sim_load_${i}`, 'content-type': 'application/json', 'content-length': String(body.length)}}, res => { res.resume(); res.on('end', () => resolve({status: res.statusCode ?? 0, ms: performance.now() - t0})); });
      req.on('error', reject); req.end(body); }); acts.push(r.ms); } };
    const probe = async () => { while (performance.now() < until) {
      const warm = performance.now() < from;   // the first half second (connections opening, the load ramping) is not measured
      const r = (await call(port, 'GET', '/v1/edge/receipts/r_1')).ms, a = (await call(port, 'POST', '/v1/edge/inbox/msg_1/ack', '{}')).ms, x = (await call(port, 'POST', '/v1/edge/inbox/msg_1/result', '{"status":"done"}')).ms;
      if (!warm) { c0.receipt.push(r); c0.ack.push(a); c0.result.push(x); }
      await new Promise(r => setTimeout(r, 50));
    } };
    const listens = async () => { while (performance.now() < until) { const warm = performance.now() < from, late = (await call(port, 'GET', '/v1/edge/inbox/listen?timeoutMs=250')).ms - 250; if (!warm) c0.listenLate.push(late); } };
    await Promise.all([...Array.from({length: 24}, (_, i) => soul(i)), probe(), listens()]);
    const line = Object.entries(c0).map(([k, v]) => `${k} n=${v.length} p99=${p99(v).toFixed(1)} max=${Math.max(...v).toFixed(1)}`).join('; ');
    console.log(`# under load: acts n=${acts.length} p50=${[...acts].sort((a, b) => a - b)[acts.length >> 1].toFixed(0)} ms; ${line}`);
    assert.ok(acts.length > 100, `the thread was kept busy (${acts.length} acts in 5 s)`);
    for (const [k, v] of Object.entries(c0)) { assert.ok(v.length >= 10, `${k}: ${v.length} samples`); assert.ok(p99(v) <= 50, `${k} p99 ${p99(v).toFixed(1)} ms > 50 ms (${line})`); }
  } finally { child.kill(); agent.destroy(); }
});

test('A4: a rich read waits at most 1 s for a running serving warm, then goes through admission (was a silent 15 s)', async () => {
  const {EdgeLedger, SERVING_WAIT_MS} = await import('./edge/ledger/ledger.ts');
  assert.equal(SERVING_WAIT_MS, 1000);
  const never = new Promise<void>(() => {}), t0 = performance.now();
  await EdgeLedger.prototype.whenServing.call({servingGate: never} as never);
  const ms = performance.now() - t0;
  assert.ok(ms >= 950 && ms < 1500, `waited ${Math.round(ms)} ms`);
});

test('A4: a warm still running after the 1 s wait is answered world.busy by name (Retry-After 2, warm;dur), not built cold', async () => {
  const {Hono} = await import('hono');
  const {servingWait} = await import('./http.ts');
  let warming = true; const app = new Hono();
  app.use('/v1/edge/*', servingWait(() => warming ? new Promise<void>(r => setTimeout(r, 50)) : null, () => warming));
  app.get('/v1/edge/here', c => c.json({here: 1}));
  const r = await app.request('/v1/edge/here', {headers: {authorization: 'Bearer sim_x'}});
  assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '2');
  assert.match(r.headers.get('server-timing') ?? '', /warm;dur=\d/);
  const b = await r.json() as {error: {code: string; message: string}}; assert.equal(b.error.code, 'world.busy'); assert.match(b.error.message, /warming up/);
  warming = false;
  assert.equal((await app.request('/v1/edge/here', {headers: {authorization: 'Bearer sim_x'}})).status, 200);
});

// #1750 A2/A3/A7: per-route server time (load/api-times.ts) and the stall line (load/stall-log.ts).
// #1944 A4: an act's four parts (queue, handler, wait, commit) and the monitor's late-tick count (load/monitor.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {Admission, admissionMiddleware} from './load/admission.ts';
import {API_ROUTES, API_WINDOW_MS, BOUNDS_MS, actTiming, apiOf, apiRoute, handlerMsOf, newSharedApi, recordApi, sharedApi} from './load/api-times.ts';
import {LoadMonitor, type HostLike} from './load/monitor.ts';
import {StallLog, stallText} from './load/stall-log.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('route ids are a closed list: ids, tokens and query values never become a route', () => {
  assert.equal(apiRoute('POST', '/v1/edge/act'), 'edge:act');
  assert.equal(apiRoute('GET', '/v1/edge/here'), 'edge:here');
  assert.equal(apiRoute('GET', '/v1/edge/inbox/listen'), 'edge:listen');
  assert.equal(apiRoute('POST', '/v1/edge/inbox/msg_79ed14ef-eb7f/ack'), 'edge:inbox/:id/ack');
  assert.equal(apiRoute('POST', '/v1/edge/inbox/msg_79ed14ef-eb7f/result'), 'edge:inbox/:id/result');
  assert.equal(apiRoute('GET', '/v1/edge/inbox/msg_79ed14ef-eb7f'), 'edge:inbox/:id');
  assert.equal(apiRoute('GET', '/v1/edge/receipts/r_26067b8e'), 'edge:receipts/:id');
  assert.equal(apiRoute('POST', '/v1/edge/objects/e_123/act'), 'edge:objects/:id/act');
  assert.equal(apiRoute('GET', '/v1/edge/s_60d6a91736'), 'edge:other');
  assert.equal(apiRoute('POST', '/v1/god/defs/s_60d6a91736'), 'god:write');
  assert.equal(apiRoute('GET', '/healthz'), null);
  assert.equal(apiRoute('GET', '/index.html'), null);
  for (const m of ['GET', 'POST']) for (const p of ['/v1/edge/a/b/c/d', '/v1/edge/act?x=sim_secret', '/v1/god/x/y']) {
    const r = apiRoute(m, p); assert.ok(r && (API_ROUTES as readonly string[]).includes(r), `${m} ${p} -> ${r}`);
  }
});

test('quantiles are bucket upper bounds within one ×1.25 bucket; the windows rotate; a long-poll records lateness', () => {
  const a = newSharedApi(); let now = 1_000_000;
  for (let i = 0; i < 990; i++) recordApi('edge:act', 0, 10, now, a);
  for (let i = 0; i < 9; i++) recordApi('edge:act', 0, 400, now, a);
  recordApi('edge:act', 2, 3000, now, a);
  let b = apiOf(a, now).routes['edge:act']!;
  assert.equal(b.n, 1000);
  assert.ok(b.handler.p50 >= 10 && b.handler.p50 <= 12.5, `p50 ${b.handler.p50}`);
  assert.ok(b.handler.p99 >= 10 && b.handler.p99 <= 12.5, `p99 ${b.handler.p99}`);
  assert.ok(b.handler.p999 >= 400 && b.handler.p999 <= 500, `p99.9 ${b.handler.p999}`);
  assert.equal(b.handler.max, 3000); assert.equal(b.queue.max, 2);
  // a window later the old answers still count (the last 5–10 min); two windows later they are gone but stay in `All`
  now += API_WINDOW_MS; recordApi('edge:here', 0, 1, now, a);
  assert.equal(apiOf(a, now).routes['edge:act']!.n, 1000);
  now += API_WINDOW_MS; recordApi('edge:here', 0, 1, now, a);
  b = apiOf(a, now).routes['edge:act']!;
  assert.equal(b.n, 0); assert.equal(b.nAll, 1000); assert.equal(b.handlerAll.max, 3000);
  assert.ok(BOUNDS_MS.length === 63 && BOUNDS_MS.at(-1)! > 100_000);
  // long-polls: listen's timeoutMs (ms), wait's timeout (s)
  assert.equal(handlerMsOf('edge:listen', 50_030, k => k === 'timeoutMs' ? '50000' : undefined), 30);
  assert.equal(handlerMsOf('edge:wait', 12_000, k => k === 'timeout' ? '55' : undefined), 0);
  assert.equal(handlerMsOf('edge:wait', 65_000, k => k === 'timeout' ? '55' : undefined), 10_000);
  assert.equal(handlerMsOf('edge:act', 7, () => '5'), 7);
  recordApi('edge:act', NaN, 1, now, a); recordApi('nope' as never, 1, 1, now, a);   // dropped, never thrown
  assert.equal(apiOf(a, now).routes['edge:act']!.n, 0);
});

test('through the middleware: a 200, a 404, a refusal and a held long-poll are counted by route, with no token or value', async () => {
  const adm = new Admission(), app = new Hono();
  app.use('*', admissionMiddleware(adm, () => 'green', c => c.req.header('authorization')?.slice(7)));
  app.get('/v1/edge/here', c => c.json({here: 1}));
  app.get('/v1/edge/objects/:id', c => c.json({error: 'gone'}, 404));
  app.post('/v1/edge/act', async c => { await sleep(60); return c.json({accepted: true}); });
  app.get('/v1/edge/inbox/listen', async c => { await sleep(Number(c.req.query('timeoutMs')) + 40); return c.json({messages: []}); });
  const h = {authorization: 'Bearer sim_tok_secret_1'};
  assert.equal((await app.request('/v1/edge/here', {headers: h})).status, 200);
  assert.equal((await app.request('/v1/edge/objects/e_secret', {headers: h})).status, 404);
  const [a1, a2] = await Promise.all([app.request('/v1/edge/act', {method: 'POST', headers: h, body: '{}'}), (async () => { await sleep(5); return app.request('/v1/edge/act', {method: 'POST', headers: h, body: '{}'}); })()]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 429], 'one act runs, the second of the same Soul is refused soul.busy');
  const listen = await app.request('/v1/edge/inbox/listen?timeoutMs=50', {headers: h});
  assert.equal(listen.status, 200); assert.match(listen.headers.get('server-timing') ?? '', /world;dur=/);
  const api = apiOf(sharedApi), r = api.routes;
  assert.equal(r['edge:here']!.n, 1); assert.equal(r['edge:objects']!.n, 1); assert.equal(r['edge:act']!.n, 2);
  assert.ok(r['edge:act']!.handler.max >= 55, `the act that ran took its 60 ms: ${r['edge:act']!.handler.max}`);
  assert.ok(r['edge:listen']!.handler.max >= 30 && r['edge:listen']!.handler.max < 1000, `listen lateness, not its hold: ${r['edge:listen']!.handler.max}`);
  const text = JSON.stringify(api);
  for (const bad of ['sim_tok', 'secret', 'e_secret', 'timeoutMs']) assert.ok(!text.includes(bad), `no ${bad} in ${text}`);
  adm.close();
});

test('a stall over 1 s logs one line with its length and what ran; 0.5 s logs nothing', () => {
  let mono = 0, tick = 100; const tickMs: number[] = [5, 5, 5], out: string[] = [];
  const s = new StallLog({ticks: () => ({tick, tickMs}), settleMs: 0, log: l => out.push(l), mono: () => mono, wall: () => Date.UTC(2026, 10, 10, 1, 0, 0) + mono});
  s.start(); s.stop();   // timers off: the test drives check() itself
  mono = 100; s.check(); mono = 200; s.check();
  // 0.5 s late: nothing
  mono = 800; s.check(); assert.equal(out.length, 0);
  // a 1.5 s request handler (edge:act), one 40 ms tick in it; a long-poll overlapping it is not named
  s.answer('edge:act', 850, 2350); s.answer('edge:listen', 0, 2400); s.answer('edge:here', 100, 120);
  tick += 1; tickMs.push(40);
  mono = 2400; s.check();
  assert.equal(out.length, 1);
  assert.match(out[0], /^\[stall\] 2026-11-10T01:00:\d\d\.\d{3}Z 1500 ms: ticks 1 \(longest 40 ms\), gc \d+ ms, answers edge:act 1, unattributed 14\d\d ms$/);
  assert.ok(!out[0].includes('listen') && !out[0].includes('here'));
  assert.equal(s.lines[0].ms, 1500);
  // the line's text form, for a tick-only stall
  assert.equal(stallText({at: 0, ms: 1200, ticks: 1, longestTickMs: 1190, gcMs: 0, answers: {}, unattributedMs: 10}), '[stall] 1970-01-01T00:00:00.000Z 1200 ms: ticks 1 (longest 1190 ms), gc 0 ms, answers none, unattributed 10 ms');
});

test('a real 1.2 s block of the main thread is noticed by the timer', async () => {
  const out: string[] = [];
  const s = new StallLog({ticks: () => ({tick: 0, tickMs: []}), settleMs: 0, log: l => out.push(l)});
  s.start(); await sleep(250);
  const t = performance.now(); while (performance.now() - t < 1200) { /* hold the thread */ }
  await sleep(250); s.stop();
  assert.equal(out.length, 1, out.join('\n')); assert.match(out[0], /^\[stall\] \S+ 1\d\d\d ms: ticks 0, gc \d+ ms, answers none/);
});

test('a serving-warm wait (before admission) is said: Server-Timing warm;dur, inside world;dur, and in the route\'s queue time', async () => {
  const {servingWait} = await import('./http.ts');
  const adm = new Admission(), app = new Hono();
  // the warm is 80 ms from when the middleware asks for it, not from when the test set it up: time before the request
  // arrives (a GC, a loaded runner) is not part of the wait it must say (#2024)
  let warming = true;
  app.use('/v1/edge/*', servingWait(() => warming ? sleep(80).then(() => {}) : null));
  app.use('*', admissionMiddleware(adm, () => 'green', c => c.req.header('authorization')?.slice(7)));
  app.post('/v1/edge/converse', c => c.json({ok: true}));
  const r = await app.request('/v1/edge/converse', {method: 'POST', headers: {authorization: 'Bearer sim_w'}, body: '{}'});
  const st = r.headers.get('server-timing') ?? '', warm = Number(/warm;dur=([\d.]+)/.exec(st)?.[1]), world = Number(/world;dur=([\d.]+)/.exec(st)?.[1]);
  assert.ok(warm >= 70 && world >= warm, st);
  assert.ok(apiOf(sharedApi).routes['edge:converse']!.queue.max >= 70);
  warming = false;
  const r2 = await app.request('/v1/edge/converse', {method: 'POST', headers: {authorization: 'Bearer sim_w'}, body: '{}'});
  assert.doesNotMatch(r2.headers.get('server-timing') ?? '', /warm/);
  adm.close();
});

test('#1944 an act says its four parts: queue + handler + wait + commit = world within 1 ms, and they reach the histograms', async () => {
  const adm = new Admission(), app = new Hono();
  app.use('*', admissionMiddleware(adm, () => 'green', c => c.req.header('authorization')?.slice(7)));
  // as the ledger marks it: bind and check inside the handler, settle's wait, then the tick (another async context) takes it
  app.post('/v1/edge/act', async c => {
    const t = actTiming.getStore()!; t.checkAt = performance.now(); t.bindMs += 3; t.routeMisses += 2;
    await sleep(20); t.waitAt = performance.now();
    await new Promise<void>(res => setTimeout(() => { t.takenAt = performance.now(); res(); }, 160));
    await sleep(10); return c.json({accepted: true});
  });
  app.get('/v1/edge/here', c => { assert.equal(actTiming.getStore(), undefined, 'no marks outside an act'); return c.json({}); });
  const before = apiOf(sharedApi).routes['edge:act']?.parts?.waitOver3TicksAll ?? 0;
  assert.equal((await app.request('/v1/edge/here', {headers: {authorization: 'Bearer sim_parts'}})).status, 200);
  const r = await app.request('/v1/edge/act', {method: 'POST', headers: {authorization: 'Bearer sim_parts'}, body: '{}'});
  const st = r.headers.get('server-timing') ?? '', d = (k: string) => Number(new RegExp(`(?:^|, )${k};dur=([\\d.]+)`).exec(st)?.[1]);
  const [world, queue, handler, wait, commit] = ['world', 'queue', 'handler', 'wait', 'commit'].map(d);
  assert.ok(Math.abs(queue + handler + wait + commit - world) <= 1, st);
  assert.ok(handler >= 18 && handler < 150 && wait >= 150 && commit >= 8 && commit < 150, st);
  // check runs from the handler's check mark to the wait: the handler's 20 ms, inside handler. handler also holds the
  // dispatch from the turn's start to that mark, which a loaded runner can stretch past 1 ms (6.3 ms in CI), so check is
  // bounded by its own 20 ms, not by handler − 1
  assert.equal(d('bind'), 3); assert.ok(d('check') >= 18 && d('check') <= handler, st); assert.match(st, /route-miss;desc=2/);
  const p = apiOf(sharedApi).routes['edge:act']!.parts!;
  assert.ok(p.wait.max >= 150 && p.commit.max >= 8 && p.handler.max >= 18, JSON.stringify(p));
  assert.equal(p.waitOver3TicksAll, before + 1);
  // parts are kept for edge:act only; a wait past three ticks (150 ms) is counted
  const a = newSharedApi();
  recordApi('edge:act', 1, 30, 1000, a, {handler: 30, wait: 0, commit: 0}); recordApi('edge:act', 1, 300, 1000, a, {handler: 20, wait: 200, commit: 80}); recordApi('edge:here', 0, 5, 1000, a, {handler: 5, wait: 99, commit: 0});
  const q = apiOf(a, 1000).routes;
  assert.equal(q['edge:act']!.parts!.waitOver3Ticks, 1); assert.equal(q['edge:act']!.parts!.commit.max, 80); assert.equal(q['edge:here']!.parts, undefined);
  adm.close();
});

test('#1944 the monitor counts ticks that started over 25 ms late, the longest gap, tick p50/p99 and the levels per window', () => {
  let mono = 0, wall = 1_000_000; const listeners: NonNullable<HostLike['listeners']> = [];
  const host: HostLike = {engine: {world: {tick: 0}}, tickMs: [], paused: false, pace: 1, baseRate: 1, running: true, clockAvailable: true, listeners};
  const api = newSharedApi(), mon = new LoadMonitor({host, api, mono: () => mono, now: () => wall, drill: 'red', shared: new Float64Array(64)});
  const tick = (start: number, own = 5) => { mono = start + own; host.tickMs.push(own); host.engine.world.tick++; mon.tickDone(); };
  mon.sample();
  for (let i = 0; i < 10; i++) tick(50 * i);                 // on time: 0 … 450
  tick(700);                                                  // a 250 ms gap: due at 500, 200 ms late
  tick(706); tick(712); tick(718); tick(724);                 // catching up back to back: due 550, 600, 650, 700 → 3 more late, the last 24 ms
  tick(774, 40);                                              // on time again, a 40 ms tick
  wall += 4000; mon.sample(); wall += 6000; mon.sample();
  const w = apiOf(api, wall).ticks!;
  assert.deepEqual({ticks: w.ticks, late: w.lateTicks, gap: w.longestGapMs, p50: w.tickMs.p50, p99: w.tickMs.p99, windowS: w.windowS}, {ticks: 16, late: 4, gap: 250, p50: 5, p99: 40, windowS: 10});
  assert.deepEqual(w.levels, {green: 0, amber: 0, red: 1, black: 0});
  // a paused clock owes nothing: the first tick after the pause is not late
  host.paused = true; mon.sample(); host.paused = false; tick(5000); tick(5050);
  wall += 10_000; mon.sample();
  assert.equal(apiOf(api, wall).ticks!.lateTicks, 0);
});

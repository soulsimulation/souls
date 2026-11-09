// node --test tools/world-launcher/soul-waits.test.mjs — #459: a Soul the world asked to wait (x-sim-soul-wait) is
// answered by the launcher until the wait elapses, so a client that ignores Retry-After costs the world's main thread
// nothing more. Per Soul token only; a client that waits its Retry-After is never refused for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { soulCeilings, SOUL_WAIT_SLACK_MS } from './flood.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';
const P0 = await testPort(4);

const ask = (tok, method = 'GET', ip = '203.0.113.5') => ({ method, headers: { authorization: `Bearer sim_s_${tok}_x`, 'x-forwarded-for': ip } });

test('a wait the world gave one Soul: refused here in its scope, with a sentence and Retry-After, until exactly the told time', () => {
  let t = 1_000_000; const c = soulCeilings({ now: () => t, log: () => {} });
  const ok = (r) => { assert.ok(r && !r.refuse, JSON.stringify(r?.refuse?.body)); r.release(); };
  const souls = ['a', 'b', 'c', 'd', 'e', 'f'], id = (k) => c.soulOf(ask(k));
  c.told('w', id('a'), '5 reads');
  // a read budget: the Soul's reads are answered here, its acts still go to the world
  const r = c.check(ask('a'), 'w', '/v1/edge/here', true, { level: 'amber' });
  // the world's own refusal shape (eden-edge/1) and busy signal
  assert.equal(r.refuse.status, 429); assert.equal(r.refuse.body.contract, 'eden-edge/1'); assert.equal(r.refuse.body.error.code, 'soul.slow-down');
  assert.match(r.refuse.body.error.message, /asked it to wait/); assert.equal(r.refuse.headers['retry-after'], '5'); assert.equal(r.refuse.headers['x-sim-load'], 'amber');
  assert.deepEqual(r.refuse.body.world, { load: 'amber', retry_after_s: 5 });
  // resolve is a read to the world: in a read wait it is answered here too
  assert.ok(c.check(ask('a', 'POST'), 'w', '/v1/edge/resolve', true).refuse);
  // a wait is per world: the same token on another world is untouched
  ok(c.check(ask('a'), 'w2', '/v1/edge/here', true));
  ok(c.check(ask('a', 'POST'), 'w', '/v1/edge/act', true));
  // six Souls from one address: the other five are untouched
  for (const k of souls.slice(1)) ok(c.check(ask(k), 'w', '/v1/edge/here', true));
  // the Retry-After counts down; a client that waits exactly what it was told is answered by the world
  t += 3000; assert.equal(c.check(ask('a'), 'w', '/v1/edge/here', true).refuse.headers['retry-after'], '2');
  t += 2000; ok(c.check(ask('a'), 'w', '/v1/edge/here', true));
  // a cool-down covers acts too; a later, shorter read wait never narrows it; the longer wait wins
  c.told('w', id('b'), '60 all'); c.told('w', id('b'), '2 reads');
  assert.equal(c.check(ask('b', 'POST'), 'w', '/v1/edge/act', true).refuse.headers['retry-after'], '60');
  t += 59_000; assert.ok(c.check(ask('b', 'POST'), 'w', '/v1/edge/say', true).refuse);
  t += 1000; ok(c.check(ask('b', 'POST'), 'w', '/v1/edge/say', true));
  assert.equal(SOUL_WAIT_SLACK_MS < 1000, true);
  // only the routes the world's own admission refuses (#1549 review): its event stream, operations, view status, plan,
  // mail, self/now, travel (its way out), receipts and listens go to the world during a cool-down and a read wait alike
  c.told('w', id('c'), '30 all'); c.told('w', id('f'), '30 reads');
  for (const k of ['c', 'f']) {
    for (const [m, path] of [['GET', '/v1/edge/events'], ['GET', '/v1/edge/operations/op_1'], ['GET', '/v1/edge/view/status'], ['GET', '/v1/edge/plan'], ['GET', '/v1/edge/mail'],
      ['POST', '/v1/edge/self/now'], ['POST', '/v1/edge/travel'], ['GET', '/v1/edge/receipts/r1'], ['GET', '/v1/edge/inbox/listen']]) ok(c.check(ask(k, m), 'w', path, true));
    for (const path of ['/v1/edge/here', '/v1/edge/view', '/v1/edge/observe', '/v1/edge/capabilities']) assert.ok(c.check(ask(k), 'w', path, true).refuse, `${k} ${path}`);
  }
  // a cool-down covers the world's C1 too; a read wait leaves them to the world (acts queue there)
  for (const path of ['/v1/edge/act', '/v1/edge/say']) { assert.ok(c.check(ask('c', 'POST'), 'w', path, true).refuse); ok(c.check(ask('f', 'POST'), 'w', path, true)); }
  ok(c.check(ask('f'), 'w', '/v1/edge/around', true));   // around is C1 in the world
  // malformed, zero or unknown-scope headers teach nothing; a request with no Soul token is never matched
  for (const h of ['', 'x all', '0 all', '-3 reads', '5 everything', '5']) c.told('w', id('d'), h);
  ok(c.check(ask('d'), 'w', '/v1/edge/here', true));
  // learnWaits: false (SIM_SOUL_WAITS=0) learns nothing
  const off = soulCeilings({ now: () => t, log: () => {}, learnWaits: false }); off.told('w', id('e'), '60 all');
  const o = off.check(ask('e'), 'w', '/v1/edge/here', true); assert.ok(o && !o.refuse); o.release();
});

test('through the launcher: after the world says wait, the Soul\'s requests never reach it until the wait ends; others do', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-waits-'));
  const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
  const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
  const hits = join(dir, 'hits.txt'); writeFileSync(hits, '');
  const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_HITS: hits, FAKE_SOUL_WAIT: '2 all' } });
  const P = P0, base = `http://127.0.0.1:${P}`;
  const L = await openLauncher({ port: P, range: [P0 + 1, P0 + 3], dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, log: () => {}, prewarm: false, publicOrigin: 'http://sim.test', devAuth: true });
  try {
    const { slug } = await (await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Patience' }) })).json();
    await (await fetch(`${base}/w/${slug}/v1/config`)).arrayBuffer();   // booted
    const reached = () => readFileSync(hits, 'utf8').split('\n').filter((l) => l.startsWith('/v1/edge/')).length;
    const hammer = { authorization: 'Bearer sim_s_cool_hammer', 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' };
    const honest = { authorization: 'Bearer sim_s_honest_x', 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' };
    const call = async (h, path = 'act') => { const s = performance.now(); const r = await fetch(`${base}/w/${slug}/v1/edge/${path}`, { method: 'POST', headers: h, body: '{}' }); return { status: r.status, retry: r.headers.get('retry-after'), wait: r.headers.get('x-sim-soul-wait'), body: await r.json(), ms: performance.now() - s }; };
    writeFileSync(hits, '');
    const first = await call(hammer);
    assert.equal(first.status, 429); assert.equal(first.body.error.code, 'soul.slow-down'); assert.equal(first.wait, null, 'the header stays between world and launcher');
    assert.equal(reached(), 1);
    const flood = []; for (let i = 0; i < 40; i++) flood.push(await call(hammer, i % 2 ? 'act' : 'say'));
    assert.equal(reached(), 1, 'none of the 40 retries inside the wait reached the world');
    assert.ok(flood.every((r) => r.status === 429 && r.body.error?.code === 'soul.slow-down' && r.body.limit?.scope === 'soul' && Number(r.retry) >= 1 && r.body.error.message.length > 20), JSON.stringify(flood[0]));
    const p99 = flood.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(flood.length * 0.99)];
    assert.ok(p99 <= 50, `launcher refusal p99 ${p99.toFixed(1)} ms`);
    // a Soul from the same address is answered by the world meanwhile
    const h = await call(honest); assert.equal(h.status, 200); assert.equal(reached(), 2);
    // waiting the Retry-After it was given: the world answers it again (and here, says wait again)
    await new Promise((r) => setTimeout(r, Number(first.retry) * 1000));
    const again = await call(hammer); assert.equal(again.status, 429); assert.ok(!again.body.limit, 'answered by the world'); assert.equal(reached(), 3);
    const dash = await (await fetch(`${base}/__sim/health?json=1`)).json();
    assert.ok(dash.worlds.find((w) => w.slug === slug).refused['soul.slow-down'] >= 40);
  } finally { await L.close(); }
});

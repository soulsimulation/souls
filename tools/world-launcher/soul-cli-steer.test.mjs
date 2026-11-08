// #1337 (P9): the CLI steers rides legally and says where the world adjusted it. A steer is checked against the ride's own
// offer first; a steer refused for its target is not sent again; the answer keeps one `adjusted` sentence (the landing the
// world chose, or what it read the words as) and says when the world's clock has stalled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landingSentence, stalledSentence, STEER_TARGET_REFUSALS } from './soul/eden.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const RIDE = 'ride-eden-balloon', STEER = `object:${RIDE}:steer`;
const steerAction = (blocked) => ({ object: { id: RIDE, kind: 'ride', actions: [{ action: 'join', available: false }, { action: 'steer', available: !blocked, ...(blocked ? { blocked } : {}) }] } });

async function fixture(t, { onAct, object = () => steerAction(null) }) {
  const dir = mkdtempSync(join(tmpdir(), 'souls-steer-')), seen = [];
  let api;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      const s = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null }; seen.push(s);
      if (req.url === `/v1/edge/objects/${RIDE}`) { const o = object(); return o === 500 ? json(res, 500, { error: { code: 'unavailable' } }) : json(res, 200, o); }
      if (req.url === '/v1/edge/act') return onAct(s, res);
      if (req.url.startsWith('/v1/edge/wait') && api.waitFrame) return setTimeout(() => json(res, 200, api.waitFrame), 200);
      if (req.url.startsWith('/v1/edge/receipts/')) return json(res, 200, { receipt: { id: 'r_6', capability: 'walk:flag-orchard', phase: 'started' } });
      json(res, 200, {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_steer', token: 'synthetic-steer-token' }), { mode: 0o600 });
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = (...args) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, EDEN_TIME_SCALE: '0.02' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('exit', code => { let d = null; try { d = JSON.parse(out); } catch {} resolve({ code, d, stdout: out, stderr: err }); });
  });
  api = { seen, run, acts: () => seen.filter(s => s.url === '/v1/edge/act'), waitFrame: null };
  return api;
}

test('landingSentence: the distance, the place asked, where and why, always "lands", bounded; nothing when nothing moved', () => {
  const l = { requested: 'Eden Library', at: 'the lawn east of its door', adjustedM: 14.4, reason: 'The library has no room for the basket.' };
  assert.equal(landingSentence(l), 'Lands 14 m from Eden Library, at the lawn east of its door: The library has no room for the basket.');
  assert.equal(landingSentence({ ...l, requested: { label: 'Eden Library' }, at: null, reason: null }), 'Lands 14 m from Eden Library.');
  assert.ok(landingSentence({ ...l, requested: 'x'.repeat(500), at: 'y'.repeat(500), reason: 'z'.repeat(500) }).length <= 250);
  for (const none of [null, { adjustedM: 0 }, { adjustedM: 'x' }]) assert.equal(landingSentence(none), null);
  for (const c of ['ride.no-landing-spot', 'ride.out-of-bounds', 'steer.unknown-place']) assert.ok(STEER_TARGET_REFUSALS.has(c), c);
  for (const c of ['ride.steered', 'ride.on-ground', 'ride.not-aboard', 'ride.no-water-route']) assert.ok(!STEER_TARGET_REFUSALS.has(c), c);
  assert.equal(stalledSentence({ stalled: true, tick_age_ms: 4200, note: "The world's clock has not moved for 4 s; nothing you do takes effect until it runs again." }), "The world's clock has not moved for 4 s; nothing you do takes effect until it runs again.");
  assert.equal(stalledSentence({ stalled: true, tick_age_ms: 4200 }), "The world's clock has not moved for 4 s; what I asked waits until it runs again.");
});

test('"land at the library" is one accepted steer, and the answer names the real landing distance', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { onAct: (s, res) => json(res, 200, { accepted: true, receipt: { id: 'r_1', capability: STEER, phase: 'started', now: 'steering toward the lawn' }, channel: 'body',
    result: { steering: RIDE, toward: 'the lawn east of Eden Library', land: true, landing: { requested: 'Eden Library', at: 'the lawn east of its door', adjustedM: 14, reason: 'The library has no room for the basket' } } }) });
  const got = await f.run('act', STEER, '{"to":"Eden Library","land":true}');
  assert.equal(got.code, 0, got.stderr);
  assert.equal(f.acts().length, 1, 'one steer');
  assert.deepEqual(f.acts()[0].body.params, { to: 'Eden Library', land: true });
  assert.equal(got.d.accepted, true);
  assert.equal(got.d.adjusted, 'Lands 14 m from Eden Library, at the lawn east of its door: The library has no room for the basket.');
});

test('a steer the world refused for its target is answered with the world\'s words the second time, and not sent; another target is', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { onAct: (s, res) => s.body.params.to === 'the pond'
    ? json(res, 200, { accepted: false, code: 'ride.no-landing-spot', reason: 'There is no clear ground to land on within 30 m of the pond; the nearest is 42 m north.', capability: STEER })
    : json(res, 200, { accepted: true, receipt: { id: 'r_2', capability: STEER, phase: 'started' }, channel: 'body' }) });
  const first = await f.run('act', STEER, '{"to":"the pond","land":true}');
  assert.equal(first.d.accepted, false); assert.equal(first.d.code, 'ride.no-landing-spot');
  const again = await f.run('act', STEER, '{"land":true,"to":"the pond"}');
  assert.equal(again.d.accepted, false); assert.equal(again.d.code, 'ride.no-landing-spot'); assert.equal(again.d.repeat, 'refused');
  assert.match(again.d.reason, /^There is no clear ground to land on within 30 m of the pond/);
  assert.equal(f.acts().length, 1, 'the world saw the refused steer once');
  const other = await f.run('act', STEER, '{"to":"the meadow","land":true}');
  assert.equal(other.d.accepted, true); assert.equal(f.acts().length, 2);
});

test('"land here" and a direction depend on where the ride is now: a refusal of either is never remembered', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { onAct: (s, res) => json(res, 200, { accepted: false, code: s.body.params.land ? 'ride.no-landing-spot' : 'ride.out-of-bounds', reason: 'Not here.', capability: STEER }) });
  for (const p of ['{"land":true}', '{"land":true}', '{"direction":"N","distance":100}', '{"direction":"N","distance":100}']) assert.equal((await f.run('act', STEER, p)).d.repeat, undefined);
  assert.equal(f.acts().length, 4, 'each sent: the ride may have moved');
});

test('a refusal that passes (someone else is steering) is not remembered', { timeout: 10_000 }, async t => {
  let n = 0;
  const f = await fixture(t, { onAct: (s, res) => ++n === 1
    ? json(res, 200, { accepted: false, code: 'ride.steered', reason: 'Mira is steering it; wait until they stop or land.', capability: STEER })
    : json(res, 200, { accepted: true, receipt: { id: 'r_3', capability: STEER, phase: 'started' }, channel: 'body' }) });
  assert.equal((await f.run('act', STEER, '{"to":"the meadow"}')).d.code, 'ride.steered');
  assert.equal((await f.run('act', STEER, '{"to":"the meadow"}')).d.accepted, true);
  assert.equal(f.acts().length, 2);
});

test('the ride\'s own offer says blocked: answered without an act; an unreadable offer changes nothing', { timeout: 10_000 }, async t => {
  let blocked = { code: 'ride.steered', reason: 'Mira is steering it; wait until they stop or land.' };
  const f = await fixture(t, { object: () => blocked ? steerAction(blocked) : 500, onAct: (s, res) => json(res, 200, { accepted: true, receipt: { id: 'r_4', capability: STEER, phase: 'started' }, channel: 'body' }) });
  const got = await f.run('act', STEER, '{"to":"the meadow"}');
  assert.deepEqual([got.d.accepted, got.d.code, got.d.preflight], [false, 'ride.steered', true]);
  assert.equal(got.d.reason, 'Mira is steering it; wait until they stop or land.');
  assert.equal(f.acts().length, 0, 'nothing sent');
  blocked = null;
  const sent = await f.run('act', STEER, '{"to":"the meadow"}');
  assert.equal(sent.d.accepted, true); assert.equal(f.acts().length, 1);
  assert.equal(f.seen.filter(s => s.url === `/v1/edge/objects/${RIDE}`).length, 2, 'one offer read per steer');
});

test('other acts read no offer; words read as another id and a stalled clock are said', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { onAct: (s, res) => json(res, 200, { accepted: true, receipt: { id: 'r_5', capability: 'walk:flag-orchard', phase: 'started' }, channel: 'body',
    resolved: { from: 'walk:orchard', to: 'walk:flag-orchard', note: 'The orchard is reached by its flag.' }, world: { load: 'red', stalled: true, tick_age_ms: 4200, note: "The world's clock has not moved for 4 s; nothing you do takes effect until it runs again." } }) });
  const got = await f.run('act', 'walk:orchard');
  assert.equal(got.code, 0, got.stderr);
  assert.equal(f.seen.filter(s => s.url.startsWith('/v1/edge/objects/')).length, 0);
  assert.equal(got.d.adjusted, 'The orchard is reached by its flag.');
  assert.equal(got.d.stalled, "The world's clock has not moved for 4 s; nothing you do takes effect until it runs again.");
});

test('a wait whose frames say the clock has stalled says so in the answer', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { onAct: (s, res) => json(res, 200, { accepted: true, receipt: { id: 'r_6', capability: 'walk:flag-orchard', phase: 'started' }, channel: 'body' }) });
  const stall = { load: 'red', stalled: true, tick_age_ms: 9000, note: "The world's clock has not moved for 9 s; nothing you do takes effect until it runs again." };
  const got = await (async () => { f.waitFrame = { events: [], cursor: 'c_1', world: stall }; return f.run('act', 'walk:flag-orchard', '--wait', '1'); })();
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.d.stalled, stall.note);
});

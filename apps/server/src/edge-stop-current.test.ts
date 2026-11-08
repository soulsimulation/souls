// #1381 (Gene's Eden smoke test, bug 11): "wait, pause" was sent as stand:here after the walk had ended, so nothing was
// stopped and nothing said so. stop:current stops the act under way, or answers honestly that nothing runs.
// Hello-hamlet, a real genesis, the real routes over HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
const FAR = 'walk:knoll';

async function world(t: {after(f: () => void): void}) {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const app = buildApp({cfg: {...config, port: 5967, worldPath: '/w/eden', publicUrl: 'http://127.0.0.1:5967/w/eden', accountAuthRequired: false, webDir: '/nonexistent-stop', marsWebDir: '/nonexistent-stop'}, db: w.db, host: w.host, auth: w.auth, brain: w.brain, souls: w.souls, edge: w.edge, hub: {clients: new Map(), refreshMe() {}} as never});
  const token = w.souls.pairExchange(w.souls.pairCode(w.db.soul(w.soul.soulId)!, 'http://127.0.0.1:5967').code, 'scripted').token;
  const req = async (path: string, auth?: string, body?: unknown) => {const r = await app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {...(auth ? {authorization: `Bearer ${auth}`} : {}), 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}); return {status: r.status, data: await r.json() as any};};
  const act = async (capability: string, extra: Record<string, unknown> = {}) => (await accept(w.host, req('/v1/edge/act', token, {capability, ...extra}))).data;
  const rec = (id: string) => w.edge.receipt(w.soul.soulId, id)!;
  const until = async (ok: () => boolean, ticks = 6000) => {for (let i = 0; i < ticks && !ok(); i += 10) await w.settle(10); assert.ok(ok(), 'reached in time');};
  const body = () => (w.host.engine.world.entities as Record<string, any>)[w.soul.entityId];
  const receipts = () => (w.db.db.prepare('SELECT COUNT(*) n FROM edge_receipts_v1 WHERE soul_id=?').get(w.soul.soulId) as {n: number}).n;
  const caps = async () => (await req('/v1/edge/capabilities?all=1', token)).data.capabilities as {id: string; label: string; available: boolean}[];
  return {w, req, act, rec, until, body, receipts, caps, token};
}

test('#1381 S1 S6: a walk under way stops where it is; the walk ends act.stopped and the stop names it; offered only while it runs', {timeout: 300000}, async t => {
  const {w, req, act, rec, until, body, caps, token} = await world(t);
  assert.ok(!(await caps()).some(c => c.id === 'stop:current'), 'not offered with nothing running');
  const walk = await act(FAR); assert.equal(walk.accepted, true, JSON.stringify(walk));
  await until(() => rec(walk.receipt.id).phase === 'started' && w.host.engine.programOf(w.soul.entityId) !== null);
  await w.settle(40);
  const offered = (await caps()).find(c => c.id === 'stop:current');
  assert.ok(offered && offered.available, 'offered while the walk runs'); assert.match(offered!.label, /walk:knoll/);
  const here = async () => ((await req('/v1/edge/here?include=doHere', token)).data.here?.doHere ?? []) as {id: string}[];
  assert.ok((await here()).some(c => c.id === 'stop:current'), 'here offers it while the walk runs');
  // resolve: the words mean it while it runs
  assert.notEqual((await req('/v1/edge/resolve', token, {capability: 'wait'})).data.resolve.would?.capability, 'stop:current', 'bare "wait" is not a stop');
  for (const words of ['stop', 'pause', 'stop what you are doing', 'cancel', 'wait, pause']) {
    const r = (await req('/v1/edge/resolve', token, {capability: words})).data.resolve;
    assert.equal(r.would?.capability, 'stop:current', `${words}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  const posture = body().human?.activity, at = [...body().pose.p];
  const stop = await act('stop:current'); assert.equal(stop.accepted, true, JSON.stringify(stop));
  assert.equal(stop.stopped, walk.receipt.id); assert.equal(stop.receipt.stopped, walk.receipt.id); assert.equal(stop.receipt.phase, 'completed');
  const ended = rec(walk.receipt.id); assert.equal(ended.phase, 'failed'); assert.equal(ended.code, 'act.stopped'); assert.equal(ended.reason, 'Stopped at your request');
  await until(() => w.host.engine.programOf(w.soul.entityId) === null, 400);
  await w.settle(40);
  const moved = Math.hypot(body().pose.p[0] - at[0], body().pose.p[2] - at[2]);
  assert.ok(moved < 3, `stops where it is (moved ${moved.toFixed(2)} m after the stop, no teleport)`);
  assert.equal(rec(walk.receipt.id).phase, 'failed', 'stays stopped');
  assert.ok(['stand', 'walk', 'idle', undefined].includes(body().human?.activity) && body().human?.activity !== 'sit', `posture unchanged in kind (${posture} -> ${body().human?.activity})`);
  const again = await act('stop:current'); assert.equal(again.code, 'act.none-running');
  assert.ok(again.reason.includes(FAR) && again.reason.includes('was already stopped'), `names the stopped walk, not the stop: ${again.reason}`);
  assert.ok(!(await caps()).some(c => c.id === 'stop:current'), 'not offered once nothing runs');
  assert.ok(!(await here()).some(c => c.id === 'stop:current'), 'nor in here');
  // with nothing open, "stop" means what it meant (stand:here)
  assert.notEqual((await req('/v1/edge/resolve', token, {capability: 'stop'})).data.resolve.would?.capability, 'stop:current');
});

test('#1381 S2 S3: nothing running is refused naming the last act, and writes nothing; an ended receipt is refused act.already-ended', {timeout: 300000}, async t => {
  const {act, rec, until, receipts} = await world(t);
  const none0 = await act('stop:current');
  assert.equal(none0.accepted, false); assert.equal(none0.code, 'act.none-running'); assert.match(none0.reason, /Nothing to stop/);
  const wave = await act('wave:here'); assert.equal(wave.accepted, true, JSON.stringify(wave));
  await until(() => !['waiting', 'started'].includes(rec(wave.receipt.id).phase));
  const n = receipts(), r = rec(wave.receipt.id);
  const none = await act('stop:current');
  assert.equal(none.accepted, false); assert.equal(none.code, 'act.none-running');
  assert.ok(none.reason.includes('wave:here') && none.reason.includes(wave.receipt.id) && none.reason.includes(r.phase), none.reason);
  assert.equal(receipts(), n, 'no receipt is written');
  assert.equal(rec(wave.receipt.id).phase, r.phase, 'nothing ended or replaced');
  const ended = await act('stop:current', {params: {receipt: wave.receipt.id}});
  assert.equal(ended.accepted, false); assert.equal(ended.code, 'act.already-ended'); assert.ok(ended.reason.includes(r.phase), ended.reason);
  assert.equal(receipts(), n);
  assert.equal((await act('stop:current', {params: {receipt: 'r_nope'}})).code, 'receipt.unknown');
  assert.equal((await act('stop:current', {params: {when: 'now'}})).code, 'capability.params');
});

test('#1381 S4: a seated Soul with a timed read under way stays seated after the stop', {timeout: 300000}, async t => {
  const {w, act, rec, until, body, caps} = await world(t);
  const sit = (await caps()).find(c => c.id.startsWith('sit:') && c.id !== 'sit:here' && c.available); assert.ok(sit, 'a seat on offer');
  const s = await act(sit!.id); assert.equal(s.accepted, true, JSON.stringify(s));
  await until(() => rec(s.receipt.id).phase !== 'waiting' && (body().human?.activity === 'sit' || body().human?.baseActivity === 'sit' || !['waiting', 'started'].includes(rec(s.receipt.id).phase)), 12000);
  const read = await act('read:here', {params: {seconds: 300}}); assert.equal(read.accepted, true, JSON.stringify(read));
  await until(() => rec(read.receipt.id).phase === 'started'); await w.settle(40);
  const stop = await act('stop:current'); assert.equal(stop.accepted, true, JSON.stringify(stop)); assert.equal(stop.stopped, read.receipt.id);
  assert.equal(rec(read.receipt.id).code, 'act.stopped');
  await w.settle(200);
  const h = body().human; assert.ok(h?.activity === 'sit' || h?.baseActivity === 'sit', `still seated: ${JSON.stringify({a: h?.activity, b: h?.baseActivity})}`);
});

test('#1381 S5: an owner message linked to the stopped act closes as stopped at the Soul\'s request', {timeout: 300000}, async t => {
  const {w, req, act, rec, until, token} = await world(t);
  const box = `/v1/edge/owner/${w.soul.soulId}/inbox`;
  assert.equal((await req(box, 'dev:ana', {text: 'walk to the knoll'})).status, 200);
  const m = (await req('/v1/edge/inbox/listen?timeoutMs=0', token)).data.backlog.at(-1).id as string;
  assert.equal((await req(`/v1/edge/inbox/${m}/ack`, token, {reply: 'On it'})).status, 200);
  const walk = await act(FAR, {for: m}); assert.equal(walk.accepted, true, JSON.stringify(walk));
  await until(() => rec(walk.receipt.id).phase === 'started'); await w.settle(20);
  const stop = await act('stop:current'); assert.equal(stop.accepted, true, JSON.stringify(stop));
  const row = () => w.db.db.prepare('SELECT result,outcome,result_by FROM soul_inbox_queue_v1 WHERE id=?').get(m) as {result: string | null; outcome: string | null; result_by: string | null};
  for (let i = 0; i < 100 && !row().result; i++) {await w.settle(10); await new Promise(r => setTimeout(r, 30));}
  assert.equal(row().outcome, 'failed'); assert.equal(row().result_by, 'server');
  assert.equal(row().result, `Stopped at your request before it finished: ${FAR}.`);
});

test('#1381 review: a stop that cannot be recorded is refused and stops nothing; the act runs on', {timeout: 300000}, async t => {
  const {w, act, req, token, rec, until, receipts} = await world(t);
  const walk = await act(FAR); assert.equal(walk.accepted, true, JSON.stringify(walk));
  await until(() => rec(walk.receipt.id).phase === 'started' && w.host.engine.programOf(w.soul.entityId) !== null);
  // the sequencer refuses the stop's event (as a clock that fails at the drain does): the event and its receipts are one acceptance
  const n = receipts(), host = w.host as unknown as {enqueueChecked: (...a: unknown[]) => Promise<unknown>}, real = host.enqueueChecked;
  host.enqueueChecked = function (kind: unknown, ...rest: unknown[]) { return kind === 'edge-stop' ? Promise.reject(new Error('engine.halted: test')) : real.call(this, kind, ...rest); };
  let stop: any; try { stop = (await req('/v1/edge/act', token, {capability: 'stop:current'})).data; } finally { host.enqueueChecked = real; }
  assert.equal(stop.accepted, false, JSON.stringify(stop)); assert.equal(stop.code, 'state.changed'); assert.match(stop.reason, /nothing was stopped/);
  assert.equal(rec(walk.receipt.id).phase, 'started', 'the walk is not reported stopped'); assert.equal(receipts(), n, 'nothing written');
  assert.ok(w.host.engine.programOf(w.soul.entityId) !== null, 'and it still runs');
});

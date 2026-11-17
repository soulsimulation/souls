// #2538 A1: with the world's disk under its headroom (a faked free-space reading), every upload route answers
// 507 host.disk-low with Retry-After; a Soul's act and the world's tick go on. Fake minds, temp dirs, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Hono} from 'hono';
import {fixture, invite, accept, factory} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {mountEdgeRoutes, edgeSoulResolver} from '../edge/routes.ts';
import {rigidGLB} from '../edge/body/testing.ts';
import {mountArtRoutes} from '../art/routes.ts';
import {AssetStore, mountAssetRoutes} from '../god/assets.ts';
import {ApiError} from '../souls.ts';
import {diskHeadroom, DISK_LOW_RETRY_S} from './disk-headroom.ts';

let free = 50_000;
const headroom = diskHeadroom({path: '.', minFreeMb: 1024, prune: () => {}, log: () => {}, free: () => free});
const low = () => { free = 10; assert.equal(headroom.look(), true); };
const ok = () => { free = 50_000; assert.equal(headroom.look(), false); };
/** The server's own error answer (http.ts onError): the ApiError's code, message and extra fields. */
const onError = (e: Error, c: any) => e instanceof ApiError ? c.json({ok: false, code: e.code, message: e.message, ...e.extra}, e.status) : c.json({code: 'error', message: String(e)}, 500);
async function refused(r: Response) {
  assert.equal(r.status, 507, await r.clone().text());
  assert.equal(r.headers.get('retry-after'), String(DISK_LOW_RETRY_S));
  const b = await r.json() as any, e = b.error ?? b;
  assert.equal(e.code, 'host.disk-low'); assert.equal(e.retry_after, DISK_LOW_RETRY_S); assert.match(e.message, /disk is nearly full.*Try again in 5 minutes/);
}

test('disk low: a Soul still acts and the world still ticks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'disk-low-')), f = fixture(join(dir, 'sim.db'), factory, {durableClockV1: true}); f.brain.quiesce();
  t.after(() => { ok(); f.host.stop(); if (f.db.db.isOpen) f.db.close(); rmSync(dir, {recursive: true, force: true}); });
  await invite(f, 'a');
  const row = await accept(f.host, f.souls.create('dev:a', {name: 'Disk a', description: 'disk-low test'}));
  const token = f.souls.pairExchange(f.souls.pairCode(row, 'http://127.0.0.1:4958').code, 'scripted').token;
  const app = new Hono(); mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: new EdgeLedger(f.host, f.db, undefined, {ambient: false}), soul: edgeSoulResolver(f.host, f.souls, c => c.req.header('authorization')?.replace(/^Bearer /, ''))});
  low();
  const said = await accept(f.host, Promise.resolve(app.request('/v1/edge/say', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({text: 'the disk is low and I still speak'})})));
  assert.equal(said.status, 200, await said.clone().text());
  const tick = f.host.engine.world.tick; for (let i = 0; i < 10; i++) f.host.tickOnce();
  assert.equal(f.host.engine.world.tick, tick + 10, 'the clock runs');
});

test('disk low: art media is refused; hanging art (an edit) is not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'disk-low-art-')); t.after(() => { ok(); rmSync(dir, {recursive: true, force: true}); });
  const app = new Hono(); let acted = 0;
  mountArtRoutes(app, {model: () => ({}) as never, godAct: () => { acted++; return {accepted: true}; }, engineAct: () => ({accepted: true}), isGod: () => true, soulFromBearer: () => null, owner: () => 'u', baseOf: () => 'http://127.0.0.1:1/w/x', limitIp: () => {}, dir});
  app.onError(onError);
  low();
  await refused(await app.request('/v1/art/media', {method: 'POST', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47])}));
  const hang = await app.request('/v1/art/hang', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({frame: 'nowhere', media: 'https://x.org/a.png'})});
  assert.notEqual(hang.status, 507, 'the hang route never reads the disk guard');
});

test('disk low: god asset and thumbnail uploads are refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'disk-low-assets-')); t.after(() => { ok(); rmSync(dir, {recursive: true, force: true}); });
  const app = new Hono();
  const god = {model: {constants: {limits: {budget: {}}}, allDefs: () => [], resolvedDef: () => undefined, def: () => undefined}, opts: {worldId: 'disk-low'}} as unknown as Parameters<typeof mountAssetRoutes>[1]['god'];
  mountAssetRoutes(app, {god, store: new AssetStore({dir}), requireGod: () => ({})});
  app.onError(onError);
  low();
  const auth = {authorization: 'Bearer god_x'};
  await refused(await app.request('/v1/god/assets?name=x', {method: 'POST', headers: {...auth, 'content-type': 'model/gltf-binary'}, body: new Uint8Array(rigidGLB())}));
  await refused(await app.request('/v1/god/defs/core/tree/thumb.png', {method: 'POST', headers: {...auth, 'content-type': 'image/png'}, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47])}));
});

// #1329 part 4 follow-up: a capabilities search (the whole menu plus up to 12 walks, built on main) has its own budget,
// 30 a minute like around; a plain listing keeps the capabilities budget, and an empty search is a plain listing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {hashToken} from './auth.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {mountEdgeRoutes, edgeSoulResolver} from './edge/routes.ts';

test('capabilities?search= has its own 30/min budget; plain listings are not charged to it', {timeout: 120000}, async t => {
  const f = fixture(':memory:'); f.brain.quiesce(); await invite(f, 'alice');
  const row = await accept<{id: string}>(f.host, f.souls.create('dev:alice', {name: 'Avery', description: 'search limit'}));
  const token = 'sim_SEARCH_LIMIT_FIXTURE'; f.db.setSoulToken(row.id, hashToken(token), 'synthetic');
  const ledger = new EdgeLedger(f.host, f.db), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, '')), ledger});
  t.after(() => { comms.close(); f.host.stop(); f.db.close(); });
  const get = async (q: string) => (await app.request('/v1/edge/capabilities' + q, {headers: {authorization: 'Bearer ' + token}})).status;
  for (let i = 0; i < 30; i++) assert.equal(await get('?all=1&search=bench'), 200, `search ${i + 1}`);
  assert.equal(await get('?all=1&search=bench'), 429, 'the 31st search in a minute');
  assert.equal(await get('?all=1'), 200, 'a plain listing is on its own budget');
  assert.equal(await get('?all=1&search=%20'), 200, 'an empty search is a plain listing');
});

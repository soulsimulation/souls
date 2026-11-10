// #628 on the real Eden 2026 template (fake minds, in memory): every act the catalog publishes is offered when asked for by id
// cold, apart from one easel whose clear ground is too far from it (it still says why). Before, 31 were refused spot.no-room:
// 29 kitchen counters, each with its own chair on its standing point, a fishing spot and that easel. A counter's craft act by
// id now walks to clear floor beside the counter and crafts there.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {accept} from '../test/native-owner-fixture.ts';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {ledgerCatalog} from './edge/catalog/routes.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json (lane/engine content)';
type Act = {accepted?: boolean; code?: string; reason?: string; receipt?: {id: string}};

test('Eden 2026: catalog acts by id are offered cold; a kitchen counter is crafted at from beside its chair', {timeout: 900_000, skip: NO_EDEN}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge as any, host = w.host;
  const run = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}} await setImmediate(); host.drainInputs();};
  await run(120);
  const refused = new Map<string, {code: string; reason: string}>();
  for (const a of ledgerCatalog(L).payload.acts) { L.invalidateBodies(); const g = L.offerGate(w.soul, {capability: a.id}); if (g) refused.set(a.id, g); }
  assert.deepEqual([...refused.keys()], ['paint:paint.e_9ae05996'], 'only the one easel with no clear ground beside it is refused');
  const easel = refused.get('paint:paint.e_9ae05996')!;
  assert.equal(easel.code, 'spot.no-room');
  assert.match(easel.reason, /waiting will not change that.*The nearest other one is .*\(paint:paint\.e_[0-9a-f]+\)/);

  // a ground-floor kitchen counter whose chair stands on its standing point (Canal Village), asked for by id from afar
  const id = 'craft:craft.e_07d35dd0', counter = host.engine.world.entities.e_07d35dd0!;
  const out = await accept(host, Promise.resolve(L.act(w.soul, {capability: id, clientRef: 'counter-1'}))) as Act;
  assert.equal(out.accepted, true, JSON.stringify(out));
  const body = () => host.engine.world.entities[w.soul.entityId]!;
  const t0 = host.engine.world.tick;
  while (body().human?.activity !== 'craft' && host.engine.world.tick - t0 < 600 * 20) await run(20);
  assert.equal(body().human?.activity, 'craft', `crafting (receipt ${JSON.stringify(L.receipt(w.soul.soulId, out.receipt!.id))})`);
  const p = body().pose.p, c = counter.pose!.p;
  assert.ok(Math.hypot(p[0] - c[0], p[2] - c[2]) <= 0.85 + 0.5 + 0.05, `at the counter (${p.map(v => v.toFixed(2))} vs ${c.map(v => v.toFixed(2))})`);
});

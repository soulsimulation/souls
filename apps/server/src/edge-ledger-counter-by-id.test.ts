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
import {activityCapabilities} from './edge/ledger/activities.ts';

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

  // review of #1832: the side search runs only where main refused. Every spot main used keeps main's point: in particular a standing
  // spot with a little room where it is (0.05 m or more, less than the 0.28 m standing room) and nothing clear straight back, which
  // main used at its own point (kitchen counters and the nave lectern on Eden 2026). `mainAt` is main's rule, copied.
  {
    const me = L.body(w.soul.entityId), aw = L.activityWorld(w.soul, me, [], new Map()), eng = L.mw as {readPassV1?: <T>(f: () => T) => T};
    const read = <T>(f: () => T): T => eng.readPassV1 ? eng.readPassV1(f) : f();
    const mainAt = (s: any): [number, number] | null => {
      if (s.seat || s.level) return s.at;
      const here = aw.clearance(s.at[0], s.at[1]); if (here >= (s.base === 'idle' ? 0.28 : 0.05)) return s.at;
      const f = s.faceTo ?? s.at, len = Math.hypot(s.at[0] - f[0], s.at[1] - f[1]); let seen = here > 0 || aw.clearance(aw.me[0], aw.me[1]) > 0;
      for (let t = 0.1; t <= 0.9 + 1e-9 && len > 1e-6; t += 0.1) {const x = Math.round((s.at[0] + (s.at[0] - f[0]) / len * t) * 100) / 100, z = Math.round((s.at[1] + (s.at[1] - f[1]) / len * t) * 100) / 100, c = aw.clearance(x, z); if (c > 0) seen = true; if (c >= 0.28) return [x, z];}
      return here >= 0.05 || !seen ? s.at : null;
    };
    const all = (L.spots.spots as any[]).filter(s => s.activity !== 'read' && !/^(frisbee|petanque|volleyball)/.test(s.activity));
    const out = read(() => activityCapabilities(L.spots, aw, new Set(all.map(s => s.id))));
    const goalOf = (s: any) => {const st = out.plans.get(`${s.activity}:${s.id}`)?.steps.filter(x => /walk_to/.test(x.verb)).at(-1); return st ? ((st.params as any).to ?? [(st.params as any).x, (st.params as any).z]) as [number, number] : null;};
    let compared = 0, band = 0; const moved: string[] = [];
    read(() => {for (const s of all) {
      const was = mainAt(s), now = goalOf(s); if (!was || !now || s.seat) continue; compared++;
      const here = aw.clearance(s.at[0], s.at[1]); if (s.base === 'idle' && here >= 0.05 && here < 0.28 && was === s.at) band++;
      if (now[0] !== was[0] || now[1] !== was[1]) moved.push(`${s.id} ${was} -> ${now}`);
    }});
    t.diagnostic(`spots main used, compared: ${compared}; of them with a little room and no clear line back: ${band}`);
    assert.ok(band >= 25, `the little-room spots are covered (${band})`);
    assert.deepEqual(moved, [], 'every spot main used walks to main\'s point');
  }

  // review of #1832: the alternative a refusal names is never in a secret place this Soul does not know
  {
    const altSpot = /\((paint:(paint\.e_[0-9a-f]+))\)/.exec(easel.reason)![2]!, place = L.spotPlace(altSpot) as string;
    assert.ok(place && L.spotPlace('paint.e_9ae05996') !== place, `the alternative stands in its own place (${place})`);
    assert.equal(L.knowledge.setSecret(place, true), true);
    L.invalidateBodies(); const g = L.offerGate(w.soul, {capability: 'paint:paint.e_9ae05996'});
    assert.equal(g?.code, 'spot.no-room', JSON.stringify(g));
    assert.ok(!g.reason.includes(altSpot) && !g.reason.includes(L.places.byId.get(place)?.name ?? '\u0000'), `the secret one is not named: ${g.reason}`);
    for (const m of g.reason.matchAll(/\(paint:(paint\.e_[0-9a-f]+)\)/g)) assert.equal(L.knowledge.knows(w.soul.soulId, L.spotPlace(m[1]!)), true, `${m[1]} is in a place it may know`);
    L.knowledge.setSecret(place, false);
  }

  // delta review of #1832: a refused spot in a secret place the Soul does not know names neither itself nor its place, on the
  // strict act path too: the act is capability.unknown, as the non-strict path answers
  {
    const own = L.spotPlace('paint.e_9ae05996') as string, ownName = L.places.byId.get(own)?.name as string;
    assert.ok(own && ownName, `the easel's place (${own})`);
    assert.equal(L.knowledge.setSecret(own, true), true);
    L.invalidateBodies(); const g = L.offerGate(w.soul, {capability: 'paint:paint.e_9ae05996'});
    assert.equal(g?.code, 'capability.unknown', JSON.stringify(g));
    assert.ok(!/easel/i.test(g.reason ?? '') && !(g.reason ?? '').includes(ownName), `nothing names the secret spot or its place: ${g.reason}`);
    L.knowledge.setSecret(own, false);
  }

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

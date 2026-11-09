// #1502: when navigation warms, the walks waiting for it are planned again on the tick without building a whole menu
// (a cold build is 100-500 ms on Eden 2026 and stops the clock), at most NAV_REPLAN_TICK_MS (40 ms) of re-planning a tick;
// the rest wait on to a later tick, flag and deadline unchanged. Each re-plan equals what the whole-menu path gave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { bootEden } from '../test/eden-capabilities-timing.ts';
import { accept, invite } from '../test/native-owner-fixture.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json (lane/engine content)';
const BUDGET_MS = 40;
/* eslint-disable @typescript-eslint/no-explicit-any */

test('#1502 R1-R3: five walks waiting at the warm moment on Eden: no whole menu built, re-plans start only while a tick has spent under 40 ms on them, each re-plan as the whole-menu path gave, each walk starts or fails with its code', { timeout: 900_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden(); t.after(() => w.close());
  const L: any = w.edge, E: any = w.host.engine;
  const souls: any[] = [w.soul];
  for (const n of ['bob', 'cy', 'di', 'eve']) { await invite(w as never, n); const row: any = await accept(w.host, w.souls.create(`dev:${n}`, { name: n, description: 'curious' })); souls.push({ soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner }); }
  await w.settle(2);
  const roof = 'walk:eden-house-3/eden-house-3-roof-planter-1', kitchen = 'walk:eden-house-3-kitchen/eden-house-3-kitchen-roof-planter-1';
  assert.equal(E.navWarmV1(0), false, 'cold just after boot');
  // four roof walks (on-demand offers: bindOne misses them) and one kitchen roof walk, which no stair reaches
  const asks = souls.map((s, i) => ({ s, cap: i === 4 ? kitchen : roof }));
  const ids: string[] = [];
  for (const { s, cap } of asks) { const o = await L.act(s, { capability: cap }); assert.equal(o.receipt?.phase, 'waiting', JSON.stringify(o)); ids.push(o.receipt.id); }
  // instruments: whole-menu builds, each re-plan's ms and tick, and the whole-menu path's answer for the same re-plan
  let builds = 0, counting = true;
  for (const name of ['wordsMenu', 'binds']) { const f = L[name].bind(L); L[name] = (...a: any[]) => { if (counting) builds++; return f(...a); }; }
  const replans: { tick: number; ms: number; same: boolean }[] = [], replan = L.navReplan.bind(L);
  const wholeMenu = (soul: any, capability: string, steps: any[]) => {   // #900's path, as it was: the whole words menu
    const walkVerbs = new Set(['walk_to', 'mars:walk_to']);
    const one = L.bindOne(soul, capability), m = one ? null : L.wordsMenu(soul), od = one ? null : L.resolveOnDemand(soul, capability, [...m.caps], new Map(m.plans));
    const cap = one ? one.cap : od.caps.find((c: any) => c.id === capability), plan = one ? one.plan : od.plans.get(capability);
    if (cap && !cap.available && cap.blocked && !['state.not-still'].includes(cap.blocked.code)) return cap.blocked;
    const fresh = plan?.steps.filter((s: any) => walkVerbs.has(s.verb));
    if (!fresh || fresh.length !== steps.filter((s: any) => walkVerbs.has(s.verb)).length) return null;
    let k = 0; return steps.map((s: any) => { if (!walkVerbs.has(s.verb)) return s; const f = fresh[k++]; return f.verb === s.verb ? { ...s, params: { ...s.params, ...f.params } } : structuredClone(f); });
  };
  // (the whole-menu answer is worked out after the tick, outside its budget, before anything moves)
  let unchecked: { soul: any; capability: string; steps: any[]; out: any; i: number }[] = [];
  L.navReplan = (soul: any, capability: string, steps: any[]) => {
    const input = structuredClone(steps), t0 = performance.now(), out = replan(soul, capability, steps), ms = performance.now() - t0;
    replans.push({ tick: w.host.engine.world.tick, ms, same: false }); unchecked.push({ soul, capability, steps: input, out: structuredClone(out), i: replans.length - 1 });
    return out;
  };
  const tickMs: number[] = [];
  assert.ok(E.navWarmV1(Infinity), 'warm');
  for (let i = 0; i < 400 && replans.length < asks.length; i++) {
    const t0 = performance.now(); w.host.tickOnce(); tickMs.push(performance.now() - t0);
    counting = false; for (const u of unchecked) replans[u.i]!.same = JSON.stringify(u.out) === JSON.stringify(wholeMenu(u.soul, u.capability, u.steps)); counting = true; unchecked = [];
  }
  const byTick = new Map<number, number[]>(); for (const r of replans) byTick.set(r.tick, [...(byTick.get(r.tick) ?? []), r.ms]);
  t.diagnostic(`warm-moment ticks (ms, whole tick): ${tickMs.map((x) => x.toFixed(1)).join(', ')}`);
  t.diagnostic(`re-plans by tick (ms each): ${[...byTick].map(([k, v]) => `${k}: ${v.map((x) => x.toFixed(1)).join('+')}`).join(' | ')}`);
  // R1: every waiting walk was planned again, and no whole menu was built for it
  assert.equal(replans.length, asks.length, 'each waiting walk planned again');
  assert.equal(builds, 0, 'no whole menu built on the tick');
  // R1 (coordinator): each re-plan is exactly what the whole-menu path gives
  assert.ok(replans.every((r) => r.same), JSON.stringify(replans));
  // R2: the budget: a re-plan starts only while the tick has spent under 40 ms on re-plans, and none is itself over it
  for (const [tick, ms] of byTick) {
    assert.ok(ms.slice(0, -1).reduce((a, b) => a + b, 0) < BUDGET_MS, `tick ${tick}: a re-plan started past the budget: ${ms}`);
    assert.ok(ms.every((x) => x < BUDGET_MS), `tick ${tick}: one re-plan over ${BUDGET_MS} ms: ${ms}`);
  }
  assert.ok(L.lastMenu.size <= souls.length, 'one kept copy a Soul at most');
  // R3: each walk ends as it did: the roof walks start, the kitchen roof walk fails route.unreachable
  for (let i = 0; i < 40 && asks.some((_, k) => L.receipt(asks[k].s.soulId, ids[k]).phase === 'waiting'); i++) await w.settle(1);
  for (const [k, { s, cap }] of asks.entries()) {
    const r = L.receipt(s.soulId, ids[k]);
    if (cap === kitchen) { assert.equal(r.phase, 'failed', JSON.stringify(r)); assert.equal(r.code, 'route.unreachable'); }
    else assert.ok(['started', 'completed'].includes(r.phase), JSON.stringify(r));
  }
});

test('#1502 R2: a wait the budget holds back keeps its navigation flag and deadline, and is planned on a later tick', { timeout: 900_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden(); t.after(() => w.close());
  const L: any = w.edge, E: any = w.host.engine;
  await invite(w as never, 'bo'); const row: any = await accept(w.host, w.souls.create('dev:bo', { name: 'Bo', description: 'curious' }));
  const bo = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner };
  await w.settle(2);
  const roof = 'walk:eden-house-3/eden-house-3-roof-planter-1';
  const a = await L.act(w.soul, { capability: roof }), b = await L.act(bo, { capability: roof });
  assert.equal(a.receipt?.phase, 'waiting'); assert.equal(b.receipt?.phase, 'waiting');
  const deadline = L.pending.get(bo.soulId).deadline;
  // the first re-plan of the tick is made to cost the whole budget, so the second is held to the next tick
  const replan = L.navReplan.bind(L), seen: { soul: string; tick: number }[] = [];
  L.navReplan = (soul: any, ...rest: any[]) => { seen.push({ soul: soul.soulId, tick: w.host.engine.world.tick }); const out = replan(soul, ...rest); if (seen.length === 1) { const end = performance.now() + BUDGET_MS + 1; while (performance.now() < end); } return out; };
  assert.ok(E.navWarmV1(Infinity));
  w.host.tickOnce();
  assert.equal(seen.length, 1, 'one re-plan this tick');
  const held = L.pending.get(bo.soulId);
  assert.ok(held, 'still pending'); assert.equal(held.navWarm, true, 'still waiting for navigation'); assert.equal(held.deadline, deadline, 'deadline unchanged');
  assert.equal(L.receipt(bo.soulId, b.receipt.id).phase, 'waiting', 'not failed early');
  w.host.tickOnce();
  assert.equal(seen.length, 2); assert.equal(seen[1]!.soul, bo.soulId); assert.equal(seen[1]!.tick, seen[0]!.tick + 1, 'planned on the next tick');
  for (let i = 0; i < 20 && L.receipt(bo.soulId, b.receipt.id).phase === 'waiting'; i++) await w.settle(1);
  assert.ok(['started', 'completed'].includes(L.receipt(bo.soulId, b.receipt.id).phase), JSON.stringify(L.receipt(bo.soulId, b.receipt.id)));
});

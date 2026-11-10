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
  const replans: { tick: number; ms: number; same: boolean; spentBefore: number }[] = [], replan = L.navReplan.bind(L);
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
    const tick = w.host.engine.world.tick, spentBefore = L.replanSpent?.tick === tick ? L.replanSpent.ms : 0;   // the ledger's own count: re-plans with their route checks
    const input = structuredClone(steps), t0 = performance.now(), out = replan(soul, capability, steps), ms = performance.now() - t0;
    replans.push({ tick, ms, same: false, spentBefore }); unchecked.push({ soul, capability, steps: input, out: structuredClone(out), i: replans.length - 1 });
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
  // R2: the budget, as the ledger counts it (re-plans with their route checks, and a relabel slice while walks are held):
  // a re-plan starts only while that is under 40 ms this tick (a tick's first always runs). Wall clock: the ms themselves are
  // diagnostics, the rule is what is asserted
  assert.equal(L.replanBudgetMs, BUDGET_MS);
  for (const r of replans.filter((x, i) => replans.findIndex((y) => y.tick === x.tick) !== i)) assert.ok(r.spentBefore < BUDGET_MS, `tick ${r.tick}: a re-plan started with ${r.spentBefore.toFixed(1)} ms already spent`);
  assert.ok(L.lastMenu.size <= souls.length, 'one kept copy a Soul at most');
  // R3: each walk ends as it did: the roof walks start, the kitchen roof walk fails route.unreachable
  for (let i = 0; i < 40 && asks.some((_, k) => L.receipt(asks[k].s.soulId, ids[k]).phase === 'waiting'); i++) await w.settle(1);
  for (const [k, { s, cap }] of asks.entries()) {
    const r = L.receipt(s.soulId, ids[k]);
    if (cap === kitchen) { assert.equal(r.phase, 'failed', JSON.stringify(r)); assert.equal(r.code, 'route.unreachable'); }
    else assert.ok(['started', 'completed'].includes(r.phase), JSON.stringify(r));
  }
});

test('#1502 R2: a wait the budget holds back keeps its navigation flag, its deadline moves with the hold, and it is planned on a later tick', { timeout: 900_000, skip: NO_EDEN }, async (t) => {
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
  assert.ok(held, 'still pending'); assert.equal(held.navWarm, true, 'still waiting for navigation'); assert.equal(held.deadline, deadline + held.held, 'the deadline moved by the ticks held, no more'); assert.equal(held.held, 1);
  assert.equal(L.receipt(bo.soulId, b.receipt.id).phase, 'waiting', 'not failed early');
  w.host.tickOnce();
  assert.equal(seen.length, 2); assert.equal(seen[1]!.soul, bo.soulId); assert.equal(seen[1]!.tick, seen[0]!.tick + 1, 'planned on the next tick');
  for (let i = 0; i < 20 && L.receipt(bo.soulId, b.receipt.id).phase === 'waiting'; i++) await w.settle(1);
  assert.ok(['started', 'completed'].includes(L.receipt(bo.soulId, b.receipt.id).phase), JSON.stringify(L.receipt(bo.soulId, b.receipt.id)));
});

test('#1502 R1: read offers made from words (the campus residences and a room) re-plan as the whole-menu path gives', { timeout: 900_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden(); t.after(() => w.close());
  const L: any = w.edge, E: any = w.host.engine;
  assert.ok(E.navWarmV1(Infinity)); await w.settle(2);
  L.capabilitiesPage(w.soul, { all: true });   // a kept menu, as an agent's read leaves it
  const walkVerbs = new Set(['walk_to', 'mars:walk_to']);
  const viaWhole = (id: string) => { const m = L.wordsMenu(w.soul), od = L.resolveOnDemand(w.soul, id, [...m.caps], new Map(m.plans)); return { cap: od.caps.find((c: any) => c.id === id), plan: od.plans.get(id) }; };
  let checked = 0;
  for (const id of ['read:g-campus-residence-1', 'read:g-campus-residence-1.living', 'read:g-campus-residence-2', 'read:g-campus-residence-2.living']) {
    const whole = viaWhole(id);
    if (!whole.plan) { t.diagnostic(`${id}: not offered from the whole menu here`); continue; }
    assert.ok(whole.plan.steps.some((x: any) => walkVerbs.has(x.verb)), `${id} walks`);
    // the plan as it was bound (its own steps), planned again: the act-time path (launch) calls this same navReplan
    const again = L.navReplan(w.soul, id, structuredClone(whole.plan.steps));
    assert.ok(Array.isArray(again), `${id}: re-planned, not ${JSON.stringify(again)}`);
    assert.deepEqual(again, whole.plan.steps.map((x: any) => x), `${id}: as the whole-menu path`);
    checked++;
  }
  assert.ok(checked >= 2, `read cases checked: ${checked}`);
});

test('#1502 R2: a 20-walk backlog at the warm moment under a tiny budget: none times out on the budget; each starts or fails with its own code', { timeout: 900_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden(); t.after(() => w.close());
  const L: any = w.edge, E: any = w.host.engine;
  L.replanBudgetMs = 0;   // one re-plan a tick, however fast the runner
  const souls: any[] = [w.soul];
  for (let i = 0; i < 19; i++) { const n = `b${i}`; await invite(w as never, n); const row: any = await accept(w.host, w.souls.create(`dev:${n}`, { name: n, description: 'curious' })); souls.push({ soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner }); }
  await w.settle(2);
  assert.equal(E.navWarmV1(0), false, 'cold');
  const roof = 'walk:eden-house-3/eden-house-3-roof-planter-1', kitchen = 'walk:eden-house-3-kitchen/eden-house-3-kitchen-roof-planter-1';
  const asks: { s: any; id: string }[] = [];
  for (const [i, s] of souls.entries()) { const o = await L.act(s, { capability: i % 4 === 3 ? kitchen : roof }); assert.equal(o.receipt?.phase, 'waiting', JSON.stringify(o)); asks.push({ s, id: o.receipt.id }); }
  // every deadline a few ticks off: only the hold keeps a walk the budget holds from timing out
  const start = w.host.engine.world.tick; for (const { s } of asks) L.pending.get(s.soulId).deadline = start + 5;
  assert.ok(E.navWarmV1(Infinity));
  let maxHeld = 0, ticks = 0;
  for (; ticks < 3000 && asks.some(({ s, id }) => L.receipt(s.soulId, id).phase === 'waiting'); ticks++) { w.host.tickOnce(); for (const p of L.pending.values()) maxHeld = Math.max(maxHeld, p.held ?? 0); if (ticks % 20 === 0) await w.settle(1); }
  const out = asks.map(({ s, id }) => L.receipt(s.soulId, id));
  t.diagnostic(`backlog settled in ${ticks} ticks; longest hold ${maxHeld} ticks; ${JSON.stringify(Object.entries(out.reduce((a: any, r: any) => (a[`${r.phase}:${r.code ?? ''}`] = (a[`${r.phase}:${r.code ?? ''}`] ?? 0) + 1, a), {})))}`);
  for (const r of out) {
    assert.notEqual(r.phase, 'waiting', JSON.stringify(r));
    assert.notEqual(r.code, 'nav.warm-timeout', `timed out on the budget: ${JSON.stringify(r)}`);
    if (r.phase === 'failed') assert.ok(r.code && r.code !== 'nav.warm-timeout', JSON.stringify(r));
  }
  assert.ok(maxHeld > 0, 'the budget held some walks');
  assert.ok(maxHeld <= 20 * 120, 'a hold is bounded');
});

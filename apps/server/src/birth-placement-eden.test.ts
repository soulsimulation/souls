// A13 (#2621): on Eden 2026, the birth path's live placement (placeNativeHumanBirth: spawnHuman's own search on the live
// engine) agrees with the detached probe it replaced (probeNativeHumanBirth: a full-world snapshot and restore) on every
// birth: the same spot, or a refusal for the same reason. Births one after another at the arrival point while a body
// walks, then the arrival point crowded until its rings are full, with the hinted forms the server sends then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { probeNativeHumanBirth, placeNativeHumanBirth, livePlacementExact } from '@souls/engine-mars';
import type { Engine, EngineFactory } from '@souls/engine-contract';
import { bootEden } from '../test/eden-capabilities-timing.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json (lane/engine content)';
type Request = { id: string; label: string; soul: string; near?: { at: [number, number]; first?: boolean } };

/** The navigation's epoch and whole-ground window: derived state the state hash cannot see (#2624 review). */
const navOf = (e: Engine) => { const sp = (e as unknown as { rt: { services: { spatial: { epoch: number; ground?: { window?: unknown } } } } }).rt.services.spatial; return JSON.stringify({ epoch: sp.epoch, window: sp.ground?.window ?? null }); };
function agrees(e: Engine, f: EngineFactory, raw: Request) {
  const hash = e.stateHash(), tick = e.world.tick;
  const { contract: _c, base: _b, ...probe } = probeNativeHumanBirth(e, f, raw), nav = navOf(e), placed = placeNativeHumanBirth(e, raw);
  assert.deepEqual(placed, probe, JSON.stringify(raw));
  assert.equal(e.stateHash(), hash); assert.equal(e.world.tick, tick); assert.equal(navOf(e), nav, 'the live placement moved the navigation');
  return placed;
}

test('A13 oracle on Eden 2026: the live birth placement equals the detached probe, plain and crowded', { timeout: 900_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden();
  t.after(() => w.close());
  w.brain.quiesce();
  const e = w.host.engine, f = w.host.factory, ana = e.world.entities[w.soul.entityId]!, at: [number, number] = [ana.pose.p[0], ana.pose.p[2]];
  assert.equal(livePlacementExact(e), true, 'Eden 2026 is on paged ground: births place on the live engine');
  const walk = e.perform({ actor: w.soul.entityId, label: 'walk', steps: [{ verb: 'walk_to', params: { to: [at[0] + 12, 0, at[1] + 8] } }] } as never) as { ok: boolean };
  assert.equal(walk.ok, true);
  const counts: Record<string, number> = {};
  const born = (req: Request) => {
    const p = agrees(e, f, req); counts[p.outcome] = (counts[p.outcome] ?? 0) + 1;
    if (p.outcome === 'ready') { e.spawnHuman(req); assert.deepEqual(e.world.entities[req.id]!.pose.p, p.position); }
    for (let i = 0; i < 2; i++) e.step();
    return p;
  };
  // plain: births one after another at the arrival point, the first Soul walking away
  for (let i = 0; i < 16; i++) born({ id: `h_a13_${i}`, label: `Joiner ${i}`, soul: `s_a13_${i}` });
  // crowded: bodies stand on the rings until a birth there is refused, then the hinted forms
  let refused = 0;
  for (let i = 16; i < 140 && refused < 2; i++) {
    const req = { id: `h_a13_${i}`, label: `Joiner ${i}`, soul: `s_a13_${i}` }, p = i % 6 === 0 ? born(req) : placeNativeHumanBirth(e, req);
    if (p.outcome === 'ready' && !e.world.entities[req.id]) e.spawnHuman(req);
    if (p.outcome === 'unavailable') { refused++; if (i % 6 !== 0) born(req); }
  }
  for (const [k, near] of [{ at }, { at: [at[0] + 6, at[1] - 4] as [number, number], first: true }].entries())
    born({ id: `h_a13_hint_${k}`, label: `Hinted ${k}`, soul: `s_a13_hint_${k}`, near });
  t.diagnostic(JSON.stringify(counts));
  assert.ok((counts.ready ?? 0) >= 16 && (counts.unavailable ?? 0) >= 1, JSON.stringify(counts));
  assert.deepEqual(e.runtime.violations, []);
});

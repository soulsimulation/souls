// #1916: walk-to:here {at: [x, z]} on the Eden 2026 template. A Soul sent to the west goal line of the football pitch
// ([36, 112]) ends within 1 m of it, walked by the engine's own walk_to (no second movement path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { accept } from '../test/native-owner-fixture.ts';
import { bootEden } from '../test/eden-capabilities-timing.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json (lane/engine content)';
type Act = { accepted?: boolean; code?: string; reason?: string; receipt?: { id: string; capability: string } };

test('Eden 2026: walk-to:here [36, 112] ends within 1 m of the west goal line', { timeout: 600_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden();
  t.after(() => w.close());
  const goal: [number, number] = [36, 112], body = () => w.host.engine.world.entities[w.soul.entityId]!;
  assert.ok(w.edge.capabilities(w.soul).some((c) => c.id === 'walk-to:here'), 'offered');
  const start = body().pose.p;
  assert.ok(Math.hypot(start[0] - goal[0], start[2] - goal[1]) > 5, `starts away from the goal (${start[0]}, ${start[2]})`);
  const out = await accept(w.host, Promise.resolve(w.edge.act(w.soul, { capability: 'walk-to:here', params: { at: goal } }))) as Act;
  assert.equal(out.accepted, true, JSON.stringify(out));
  assert.equal(out.receipt!.capability, 'walk-to:here');
  const tick = w.host.engine.world.tick;
  let phase = 'accepted';
  while (['accepted', 'waiting', 'started'].includes(phase) && w.host.engine.world.tick - tick < 600 * 20) { await w.settle(20); phase = w.edge.receipt(w.soul.soulId, out.receipt!.id)!.phase; }
  assert.equal(phase, 'completed');
  const end = body().pose.p, off = Math.hypot(end[0] - goal[0], end[2] - goal[1]);
  assert.ok(off <= 1, `ended ${off.toFixed(2)} m from [36, 112]`);
  assert.deepEqual(w.host.engine.runtime.violations, []);
});

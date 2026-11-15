// A crowd on the arrival point: the native placer's rings hold 91 bodies, and a direct create past that threw (no free
// standing room) inside the tick, which the world could only answer with a fault and a rewind of everything since its last
// snapshot. At 100 Souls on Eden 2026 that replay held the main thread past the watchdog's hang limit and the world was killed.
// A create onto a nearly full arrival point now carries birth-near/1 (no `first`): rings first as before, then free ground.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../test/native-owner-fixture.ts';

test('a hundred direct creates on one arrival point: every Soul is born, no fault, the first ones placed as before', async (t) => {
  const f = fixture(':memory:'); t.after(() => { f.host.stop(); f.db.close(); });
  for (let i = 0; i < 100; i++) { const p = f.souls.create(`crowd${i}`, { name: `Crowd ${i}`, description: 'arrival crowd fixture' }); f.host.drainInputs(); await p; }
  const births = f.db.events(f.host.worldId, 0).filter((e) => e.kind === 'birth' && /^Crowd /.test(e.payload.name));
  assert.equal(births.length, 100);
  const bodies = births.map((e) => f.host.engine.world.entities[e.payload.entityId]);
  assert.ok(bodies.every((b) => b?.kind === 'human'), 'every Soul has a body');
  assert.equal(f.host.rewinds, 0, 'no rewind');
  assert.ok(births.slice(0, 60).every((e) => !e.payload.near), 'an arrival with room keeps the default placement');
  assert.ok(births.slice(91).every((e) => e.payload.near && !e.payload.near.first), 'a full arrival carries birth-near/1, rings first');
  const pos = bodies.map((b) => [b!.pose.p[0], b!.pose.p[2]]);
  for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) assert.ok(Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) >= 0.79, `bodies ${i} and ${j} overlap`);
});

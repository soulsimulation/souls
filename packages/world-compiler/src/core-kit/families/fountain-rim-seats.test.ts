// A Soul sits on the fountain's rim: core-fountain@2's six seats are on the model's own rim, facing out; @1 keeps its bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import civic from '../civic.json' with { type: 'json' };
import { FOUNTAIN_2, RIM, rimOf } from './fountain-rim-seats.family.ts';
import { coreLibrary } from '../../library.ts';
import { WorldModel } from '../../model.ts';

test('fountain@2 seats six on its rim at the rim\'s height, facing out; @1 keeps its bytes', () => {
  const library = coreLibrary(), old = library.get('core/fountain@1')!, next = library.get('core/fountain@2')!;
  const v1 = civic.find((d) => d.name === 'core-fountain')!;
  assert.deepEqual(old.slots.map((s) => s.id), (v1.slots ?? []).map((s) => s.id), '@1 unchanged');
  assert.equal(old.hash, '840a6f717bc7d33a0f114a4e9af6f24a8ab656b9fc094ae5820219c65cd25402', '@1 keeps its bytes');
  const m = new WorldModel({ constants: { ground: 'land' }, seed: 'fountain' }); m.library = library;
  assert.equal(next.hash, m.defineDef(FOUNTAIN_2, 'core', 0).hash);
  // The basin's profile: the outer wall tops out at (2.05, 0.55) m, the inner lip at (1.8, 0.6) m.
  assert.deepEqual(RIM, rimOf([[1.95, 0], [2.05, 0.1], [2.05, 0.55], [1.8, 0.6], [1.8, 0.2], [0, 0.2]]));
  assert.ok(Math.abs(RIM.r - 1.925) < 1e-9 && RIM.y === 0.575);
  const seats = next.slots.filter((s) => s.kind === 'seat');
  assert.equal(seats.length, 6);
  for (const s of seats) {
    const [x, y, z] = s.p, r = Math.hypot(x, z);
    assert.ok(Math.abs(r - 1.925) < 0.002 && y === 0.575, `${s.id} on the rim: r ${r}, y ${y}`);
    // facing: +z turned by yaw, pointing away from the middle
    assert.ok((Math.sin(s.yaw) * x + Math.cos(s.yaw) * z) / r > 0.9999, `${s.id} faces out`);
    assert.equal(s.capacity, 1);
  }
  assert.deepEqual(next.slots.filter((s) => s.kind === 'stand').map((s) => s.id), old.slots.map((s) => s.id), "@1's stand points kept");
});

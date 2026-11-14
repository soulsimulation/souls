// #2354: a far actuator act's `approach` (put-out a fire, open a far door) makes up to 169 clearance reads and 16 reach
// checks. They only read the world, so they run inside one engine read pass (one planner sync) and answer exactly as
// the same reads one by one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GodPerceive } from './perceive.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
function host(pass: boolean) {
  const log = { passes: 0, inPass: 0, outside: 0, reach: 0 };
  let depth = 0;
  // a wall along x = 0.6 (no clearance east of it) and a post at (-0.5, 0.5); reach fails west of x = -0.9
  const engine: any = {
    world: { entities: { b1: { id: 'b1', pose: { p: [-4, 0, 3] }, human: { level: 0 } } } },
    clearanceAtV1(x: number, z: number) { if (depth) log.inPass++; else log.outside++; return x > 0.6 ? 0 : Math.hypot(x + 0.5, z - 0.5) < 0.3 ? 0.1 : 1; },
    reachV1(_a: unknown, b: { p: [number, number] }) { log.reach++; return { ok: b.p[0] > -0.9 }; },
  };
  if (pass) engine.readPassV1 = <T>(f: () => T): T => { log.passes++; depth++; try { return f(); } finally { depth--; } };
  const fire = { id: 'fire', def: 'core-fire@1' };
  const h: any = {
    model: { entities: new Map([['fire', fire]]), worldPose: () => ({ x: 0, y: 0, z: 0, yaw: 0, s: 1 }) },
    engine, engineOwned: () => false, namesNear: () => [], log: () => {},
  };
  return { approach: (new GodPerceive(h) as any).actHost().approach as (id: string, soul: unknown, front: [number, number] | null, r?: number) => unknown, log };
}

test('#2354: approach reads inside one read pass and finds the same spot as reads one by one', () => {
  const soul = { soulId: 's1', entityId: 'b1' };
  for (const front of [null, [0, 1.2] as [number, number], [-2, -2] as [number, number]]) for (const r of [1.5, 0.75]) {
    const one = host(false), passed = host(true);
    const want = one.approach('fire', soul, front, r), got = passed.approach('fire', soul, front, r);
    assert.deepEqual(got, want, `front ${JSON.stringify(front)} radius ${r}`);
    assert.equal(passed.log.passes, 1, 'one read pass per approach');
    assert.equal(passed.log.outside, 0, 'no clearance read outside the pass');
    assert.equal(passed.log.inPass, one.log.outside, 'the same reads');
    assert.equal(passed.log.reach, one.log.reach, 'the same reach checks');
  }
  // nothing to stand on: still null, still one pass
  const none = host(true); none.log.passes = 0;
  assert.equal(none.approach('missing', soul, null), null);
});

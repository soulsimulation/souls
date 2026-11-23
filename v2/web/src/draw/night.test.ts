// V19b (#3508) A3: the lamps' pools are today's (`../sky/today-parity.json`: today's outputs pinned at the port): the same
// pool for a lamp, the same light map bytes, and the same strength by the daylight.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { givesLight, lampPool, nightPools, nightStrength, paintNight, setNightStrength } from './night.ts';

const TODAY = JSON.parse(readFileSync(new URL('../sky/today-parity.json', import.meta.url), 'utf8')).night;

test('A3: lamps and fires paint today\'s light map, byte for byte', () => {
  // Today's god-world lamp at the default range (8 m): world-env.ts's pool for a lamp and for a fire.
  const sources = [lampPool(3, 4, 0.5, false), lampPool(-20, 11, 2, false), lampPool(40, -30, 0, true)];
  assert.deepEqual(sources[0], { x: 3, z: 4, base: 0.5, radius: 8 * 0.3, intensity: 0.8, color: '#ffe9c4', halo: 8 * 0.4 });
  assert.deepEqual(sources[2], { x: 40, z: -30, base: 0, radius: 8 * 0.4, intensity: 1.1, color: '#ffe9c4', halo: 8 * 0.4 });
  const ours = new Uint8Array(1536 * 1024 * 4);
  paintNight(ours, sources, { x0: -120, z0: -90, x1: 140, z1: 110 });
  let lit = 0;
  for (let k = 0; k < ours.length; k += 4) if (ours[k] || ours[k + 1] || ours[k + 2]) lit++;
  assert.equal(createHash('sha256').update(ours).digest('hex'), TODAY.map);
  console.log(`A3: 3 pools, ${lit} lit texels of ${ours.length / 4}, the same bytes as today's paintNightMap`);
});

test('A3: what gives light, and the pools at night only', () => {
  assert.ok(givesLight({ on: ['light'] }) && givesLight({ lit: ['flame'] }) && givesLight({ on: ['(glow materials)'] }));
  assert.ok(!givesLight({ on: ['screen'] }) && !givesLight({ open: ['door'] }) && !givesLight(undefined));
  // Within 1e-12: Linux and macOS libm differ in the last digit (0.35355339059327373 against …738).
  const strength = [1, 0.5, 0].map((d) => (setNightStrength(d), nightStrength()));
  assert.equal(strength.length, TODAY.strength.length);
  strength.forEach((v, i) => assert.ok(Math.abs(v - TODAY.strength[i]) < 1e-12, `strength ${i}: ${v} against ${TODAY.strength[i]}`));
  const lamp = { id: 'a', kind: 'core:street-lamp@1', origin: 'L1' }, bench = { id: 'b', kind: 'core:bench@1', origin: 'B1' };
  const at = new Map([['a', new THREE.Matrix4().makeTranslation(5, 0, -7)], ['b', new THREE.Matrix4()]]);
  const world = { nodes: new Map([['a', lamp], ['b', bench]]), extent: [-50, -50, 50, 50] as [number, number, number, number], frame: (id: string) => at.get(id)!, heightAt: () => 1.5 };
  const index = { things: { L1: 'h-lamp', B1: 'h-bench' }, states: new Map([['h-lamp', { on: ['light'] }]]) };
  assert.deepEqual(nightPools(world, index), { sources: [lampPool(5, -7, 1.5, false)], bounds: { x0: -50, z0: -50, x1: 50, z1: 50 } });
  assert.deepEqual(nightPools(world, index, (id) => id !== 'a')?.sources, []); // C8: a light put out casts no pool
});

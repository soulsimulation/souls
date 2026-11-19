// V19b (#3508) A3: the lamps' pools are today's: the same pool for a lamp, the same light map bytes, and the same pass
// in every lit material, at today's strength by the daylight.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { givesLight, lampPool, nightPools, nightStrength, paintNight, setNightStrength } from './night.ts';

// Today's module, loaded by address (it reads the page's address when loaded) so this package's type check does not
// take in today's page.
Object.assign(globalThis, { location: new URL('http://localhost/w/eden/') });
const today = await import(String(new URL('../../../../apps/web/src/WorldNightLights.ts', import.meta.url)));

test('A3: lamps and fires paint today\'s light map, byte for byte', () => {
  // Today's god-world lamp at the default range (8 m): world-env.ts's pool for a lamp and for a fire.
  const sources = [lampPool(3, 4, 0.5, false), lampPool(-20, 11, 2, false), lampPool(40, -30, 0, true)];
  assert.deepEqual(sources[0], { x: 3, z: 4, base: 0.5, radius: 8 * 0.3, intensity: 0.8, color: '#ffe9c4', halo: 8 * 0.4 });
  assert.deepEqual(sources[2], { x: 40, z: -30, base: 0, radius: 8 * 0.4, intensity: 1.1, color: '#ffe9c4', halo: 8 * 0.4 });
  const bounds = { x0: -120, z0: -90, x1: 140, z1: 110 };
  const ours = new Uint8Array(1536 * 1024 * 4);
  paintNight(ours, sources, bounds);
  const theirs = today.paintNightMap(sources, [], bounds).image.data as Uint8Array;
  let lit = 0;
  for (let k = 0; k < ours.length; k += 4) if (ours[k] || ours[k + 1] || ours[k + 2]) lit++;
  assert.deepEqual(ours, theirs);
  console.log(`A3: 3 pools, ${lit} lit texels of ${ours.length / 4}, the same bytes as today's paintNightMap`);
});

test('A3: what gives light, and the pools at night only', () => {
  assert.ok(givesLight({ on: ['light'] }) && givesLight({ lit: ['flame'] }) && givesLight({ on: ['(glow materials)'] }));
  assert.ok(!givesLight({ on: ['screen'] }) && !givesLight({ open: ['door'] }) && !givesLight(undefined));
  for (const d of [1, 0.5, 0]) {
    setNightStrength(d);
    today.setNightLightStrength(d);
    assert.equal(nightStrength(), today.nightLightStrength());
  }
  const lamp = { id: 'a', kind: 'core:street-lamp@1', origin: 'L1' }, bench = { id: 'b', kind: 'core:bench@1', origin: 'B1' };
  const at = new Map([['a', new THREE.Matrix4().makeTranslation(5, 0, -7)], ['b', new THREE.Matrix4()]]);
  const world = { nodes: new Map([['a', lamp], ['b', bench]]), extent: [-50, -50, 50, 50] as [number, number, number, number], frame: (id: string) => at.get(id)!, heightAt: () => 1.5 };
  const index = { things: { L1: 'h-lamp', B1: 'h-bench' }, states: new Map([['h-lamp', { on: ['light'] }]]) };
  assert.deepEqual(nightPools(world, index), { sources: [lampPool(5, -7, 1.5, false)], bounds: { x0: -50, z0: -50, x1: 50, z1: 50 } });
});

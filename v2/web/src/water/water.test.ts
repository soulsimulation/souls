// V19b (#3508) A2: the page's water compiles to today's shader (`../sky/today-parity.json`: today's outputs pinned at the
// port), and its waves follow world time.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { asWater, tickWater, waterMaterial } from './water.ts';

const TODAY = JSON.parse(readFileSync(new URL('../sky/today-parity.json', import.meta.url), 'utf8')).water;
const sha = (x: string) => createHash('sha256').update(x).digest('hex');

/** What a material's patch makes of three's standard shader. */
function compiled(m: THREE.Material) {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(shader as never, null as never);
  return { shader, key: m.customProgramCacheKey() };
}

test('A2: still water compiles to today\'s shader, with today\'s material', () => {
  const m = waterMaterial(), { shader, key } = compiled(m);
  assert.equal(sha(shader.vertexShader), TODAY.vertex);
  assert.equal(sha(shader.fragmentShader), TODAY.fragment);
  assert.deepEqual([key, m.color.getHex(), m.opacity, m.roughness, m.metalness], [TODAY.key, TODAY.colour, TODAY.opacity, TODAY.roughness, TODAY.metalness]);
  console.log(`A2: still water: vertex ${shader.vertexShader.length} and fragment ${shader.fragmentShader.length} characters, both equal to today's; colour #${m.color.getHexString()}, opacity ${m.opacity}, roughness ${m.roughness}, metalness ${m.metalness}`);
});

test('A2: a water area is drawn with the water, its waves at world time', () => {
  const mesh = asWater(new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial()));
  assert.equal(mesh.material, waterMaterial());
  assert.ok(mesh.geometry.getAttribute('waterUv'));
  const { shader } = compiled(waterMaterial());
  tickWater(19.5 * 3600 + 12.25);
  assert.equal(shader.uniforms.uTime.value, (19.5 * 3600 + 12.25) % 3600);
});

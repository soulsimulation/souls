// V19b (#3508) A2: the page's water compiles to today's shader, and its waves follow world time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { asWater, tickWater, waterMaterial } from './water.ts';

// Today's module, loaded by address so this package's type check does not take in today's page.
const today = await import(String(new URL('../../../../apps/web/src/gen-mesh/water.ts', import.meta.url)));

/** What a material's patch makes of three's standard shader. */
function compiled(m: THREE.Material) {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(shader as never, null as never);
  return { shader, key: m.customProgramCacheKey() };
}

test('A2: still water compiles to today\'s shader, with today\'s material', () => {
  const ours = waterMaterial(), theirs = today.waterMaterial() as THREE.MeshStandardMaterial;
  const a = compiled(ours), b = compiled(theirs);
  assert.equal(a.shader.vertexShader, b.shader.vertexShader);
  assert.equal(a.shader.fragmentShader, b.shader.fragmentShader);
  assert.equal(a.key, b.key);
  assert.equal(ours.color.getHex(), theirs.color.getHex());
  for (const k of ['opacity', 'roughness', 'metalness', 'transparent', 'side', 'depthWrite'] as const) assert.deepEqual(ours[k], theirs[k], k);
  console.log(`A2: still water: vertex ${a.shader.vertexShader.length} and fragment ${a.shader.fragmentShader.length} characters, both equal to today's; colour #${ours.color.getHexString()}, opacity ${ours.opacity}, roughness ${ours.roughness}, metalness ${ours.metalness}`);
});

test('A2: a water area is drawn with the water, its waves at world time', () => {
  const mesh = asWater(new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial()));
  assert.equal(mesh.material, waterMaterial());
  assert.ok(mesh.geometry.getAttribute('waterUv'));
  const { shader } = compiled(waterMaterial());
  tickWater(19.5 * 3600 + 12.25);
  assert.equal(shader.uniforms.uTime.value, (19.5 * 3600 + 12.25) % 3600);
});

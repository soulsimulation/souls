// #2281: the viewer draws a television's state: dark glass off, the channel's glowing picture on.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildKit } from './kit.mesh.ts';
import { MaterialLib } from './materials.ts';
import { coreLibrary } from '@souls/world-compiler';

const tv = coreLibrary().get('core/television@2')!;
const draw = (state: Record<string, unknown>) => buildKit(tv.make.kind === 'gen' ? tv.make.args as never : (null as never),
  { materials: new MaterialLib(), tint: (key, fallback) => (key ? (tv.palette as Record<string, string> | undefined)?.[key] : undefined) ?? fallback, params: { variant: 'flat' }, state });
const screen = (o: THREE.Object3D) => { const ms: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = []; o.traverse((n) => { if (n.userData.role === 'screen') n.traverse((c) => { if ((c as THREE.Mesh).isMesh) ms.push(c as never); }); }); return ms; };
const glowing = (o: THREE.Object3D) => screen(o).filter((m) => m.material.emissive && m.material.emissive.getHex() !== 0 && m.material.emissiveIntensity > 0);
const colours = (o: THREE.Object3D) => { const s = new Set<string>(); for (const m of screen(o)) { const c = m.geometry.attributes.color; if (c) for (let i = 0; i < c.count; i += 6) s.add([c.getX(i), c.getY(i), c.getZ(i)].map((v) => v.toFixed(2)).join()); } return [...s].sort().join('|'); };

test('off: the screen is drawn without glow (dark glass); on: it glows with a picture per channel', () => {
  const off = draw({ on: false, channel: 'garden' });
  assert.ok(screen(off).length > 0); assert.equal(glowing(off).length, 0, 'off: no glowing screen part');
  const pictures = new Set<string>();
  for (const channel of ['garden', 'sea', 'stars', 'test-card']) {
    const on = draw({ on: true, channel });
    assert.ok(glowing(on).length > 0, `${channel}: the screen glows`);
    assert.ok(glowing(on).every((m) => m.material.userData.kitGlowIntensity > 0), `${channel}: the screen glows in its picture's colours, not cream-white`);
    pictures.add(colours(on));
  }
  assert.equal(pictures.size, 4, 'each channel draws a different picture');
});

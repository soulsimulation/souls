// The effects on the page (0.131 parity C8, #3679), beside the thing layer (`things/page.ts`): they draw from the same
// `models` root and index and in the same frames, so none when the page draws no things.
import * as THREE from 'three';
import type { WorldView } from '../draw/world.ts';
import type { PageThings } from '../things/page.ts';
import { FxLayer } from './layer.ts';

export function pageFx(scene: THREE.Scene, world: WorldView, things: PageThings, params: URLSearchParams, phone: boolean): FxLayer | null {
  const root = params.get('models');
  if (!root || params.get('things') === '0' || params.get('fx') === '0') return null;
  const base = new URL(root, location.href), scale = new THREE.Vector3();
  const fx = new FxLayer({
    frame: (id) => {
      const n = world.nodes.get(id);
      return n ? world.frame(id).clone().scale(scale.setScalar((n.scale ?? 1_000_000) / 1_000_000)) : null;
    },
    index: () => things.layer?.opts.index ?? null,
    fetch: (h) => fetch(new URL(`worlds/models/${h}.glb`, base)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
    phone,
    standIns: (id, shown) => things.layer?.standIns(id, shown),
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
  scene.add(fx.group);
  return fx;
}

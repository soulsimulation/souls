// N-V7 (#3690): the fauna on the page. It reads the world view's copy (ground, water areas, things' kinds) to place
// the creatures, again whenever that copy has changed (checked about every two seconds, so a part that adds a pond
// or a garden is followed), and moves them by the page clock's world time with today's weather rules.
import * as THREE from 'three';
import type { WorldView } from '../draw/world.ts';
import { kindSounds } from '../sound/plan.ts';
import type { SkyState } from '../sky/sky.ts';
import { faunaAnchors, faunaLevels, type Source, type Water } from './anchors.ts';
import { Fauna } from './fauna.ts';

const MM = 1e-3, RECHECK_MS = 2000;

/** What the anchors read from the world view: its extent, height, water areas and sounding things. */
export function anchorInput(world: WorldView): { extent: WorldView['extent']; heightAt: (x: number, z: number) => number | null; water: Water[]; sources: Source[]; things: [number, number][] } {
  const water: Water[] = [], sources: Source[] = [], things: [number, number][] = [], v = new THREE.Vector3();
  let k = 0;
  for (const n of world.nodes.values()) {
    if (n.origin && k++ % 16 === 0) (v.setFromMatrixPosition(world.frame(n.id)), things.push([v.x, v.z]));
    if (n.waterLevel !== undefined && n.outline) water.push({ level: n.waterLevel * MM, points: n.outline.map(([x, z]) => [x * MM, z * MM]) });
    const specs = kindSounds(n.kind);
    if (!specs.some((s) => s.kind === 'birds' || s.kind === 'bees' || s.kind === 'waterfowl')) continue;
    // An area (a flower garden, wildflowers) is placed by its outline (world mm), a thing by its frame.
    if (n.outline?.length) {
      const [x, z] = n.outline.reduce(([a, b], [x, z]) => [a + x * MM, b + z * MM], [0, 0]).map((c) => c / n.outline!.length);
      v.set(x, world.heightAt(x, z) ?? 0, z);
    } else v.setFromMatrixPosition(world.frame(n.id));
    sources.push({ pos: [v.x, v.y, v.z], sounds: specs.map((s) => s.kind) });
  }
  return { extent: world.extent, heightAt: (x, z) => world.heightAt(x, z), water, sources, things };
}

export type PageFauna = { fauna: Fauna; update(now: number, t: number | null, sky: SkyState): void };

export function pageFauna(scene: THREE.Scene, world: WorldView, params: URLSearchParams): PageFauna | null {
  if (params.get('fauna') === '0') return null;
  const fauna = new Fauna();
  scene.add(fauna.mesh);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let checked = -Infinity, seen = '';
  return {
    fauna,
    update(now, t, sky) {
      if (now - checked >= RECHECK_MS) {
        checked = now;
        const key = `${world.nodes.size}:${world.extent?.join(',') ?? ''}`;
        if (key !== seen && world.extent) {
          seen = key;
          fauna.setAnchors(faunaAnchors(anchorInput(world)), (x, z) => world.heightAt(x, z));
        }
      }
      if (t === null) return void (fauna.mesh.visible = false);
      const l = faunaLevels(sky, reduced);
      fauna.update(t / 1e6, l.birds, l.butterflies, sky.daylight, l.ducks);
    },
  };
}

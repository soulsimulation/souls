// The thing layer on the page (V8, #2718): follows the parts the page plays and places each imported thing from its
// node, in the frame the world view computes. The page's `models` parameter is the root V17's bake wrote
// (`models.json`, `worlds/models/<hash>.glb`), served beside the stream or from the CDN; `things=0` draws none (the
// measure's other arm) and `copies=2` draws each thing twice, the copy one world's width further east.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { STRUCTURE, type WorldView } from '../draw/world.ts';
import { fetchIndex } from './models.ts';
import { ThingLayer } from './things.ts';
import { setWindowLife } from './windows.ts';
import { civil, localAt, type SkyRecord } from '../sky/record.ts';

const MM = 1e-3;

/** One box around a thing's solids (`[cx, cz, hx, hz, yaw, y0, y1, …]` mm), in its (scaled) frame; half a metre with none. */
export function boxOf(n: NodeRec): THREE.Matrix4 {
  if (!n.solids?.length) return new THREE.Matrix4().makeScale(0.5, 0.5, 0.5);
  let [x0, z0, y0, x1, z1, y1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [cx, cz, hx, hz, yaw, a, b] of n.solids) {
    const r = yaw ? Math.hypot(hx, hz) : 0, ex = r || hx, ez = r || hz;
    [x0, x1, z0, z1, y0, y1] = [Math.min(x0, cx - ex), Math.max(x1, cx + ex), Math.min(z0, cz - ez), Math.max(z1, cz + ez), Math.min(y0, a), Math.max(y1, b)];
  }
  return new THREE.Matrix4().compose(
    new THREE.Vector3(((x0 + x1) / 2) * MM, y0 * MM, ((z0 + z1) / 2) * MM),
    new THREE.Quaternion(),
    new THREE.Vector3(Math.max(0.05, (x1 - x0) * MM), Math.max(0.05, (y1 - y0) * MM), Math.max(0.05, (z1 - z0) * MM)),
  );
}

/** A box for each solid, for a thing that has no model: a pitch's goals and fences, not one slab over the pitch.
 *  `ground` gives the ground's height under a solid whose heights are above the ground (a thing laid out in the world's
 *  frame on the open ground, unless its `abs` flag is set). */
export function solidBoxes(n: NodeRec, ground: ((x: number, z: number) => number | null) | null = null): THREE.Matrix4[] {
  return (n.solids ?? []).map(([cx, cz, hx, hz, yaw, y0, y1, , abs]) => new THREE.Matrix4().compose(
    new THREE.Vector3(cx * MM, y0 * MM + (ground && !abs ? ground(cx * MM, cz * MM) ?? 0 : 0), cz * MM),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yaw / 1000) * (Math.PI / 180)),
    new THREE.Vector3(Math.max(0.05, 2 * hx * MM), Math.max(0.05, (y1 - y0) * MM), Math.max(0.05, 2 * hz * MM)),
  ));
}

export type PageThings = {
  layer: ThingLayer | null; apply(nodes: NodeRec[], removed: string[]): void; update(eye: THREE.Vector3): void;
  /** #3603: moves what rides a course to where the world view has it at the drawn time; call after `world.draw`. */
  follow(): void;
  /** C10: the world time drawn and the sky's record then, for the lit windows' share by local hour (today's
   *  `setWindowLife`); until it is called, today's 0.6 of the rooms are lit at night. */
  night(t: number | null, record: SkyRecord | null): void;
};

/** The windows' life at world time `t` (µs): the local hour on the world's clock, and seconds for the rooms' people. */
export function windowLife(t: number | null, record: SkyRecord | null): void {
  setWindowLife(t !== null && record ? civil(localAt(record, t)).hour : null, Math.max(0, t ?? 0) / 1e6);
}

/** The page's things, from its parameters; none (the world view's boxes stay) when no `models` root is given. */
export function pageThings(scene: THREE.Scene, world: WorldView, params: URLSearchParams): PageThings {
  const root = params.get('models');
  const none: PageThings = { layer: null, apply() {}, update() {}, follow() {}, night: windowLife };
  if (!root) return none;
  world.drawThings = false;
  if (params.get('things') === '0') return none;
  const base = new URL(root, location.href);
  let layer: ThingLayer | null = null;
  const early: [NodeRec[], string[]][] = [];
  const out: PageThings = {
    layer: null,
    apply(nodes, removed) {
      if (!layer) return void early.push([nodes, removed]);
      if (world.extent) layer.spacing = world.extent[2] - world.extent[0];
      for (const id of removed) layer.remove(id);
      for (const n of nodes) {
        if (n.at !== null || STRUCTURE.has(n.kind.split('@')[0])) continue;
        const model = n.origin && layer.opts.index.things[n.origin];
        const box = model ? boxOf(n) : solidBoxes(n, n.parent === world.groundId && n.pos.every((v) => v === 0) ? (x, z) => world.heightAt(x, z) : null);
        layer.set(n.id, n.origin ?? null, world.frame(n.id).clone().scale(new THREE.Vector3().setScalar((n.scale ?? 1_000_000) / 1_000_000)), box);
      }
    },
    update(eye) {
      layer?.update(eye);
    },
    follow() {
      if (!layer) return;
      const s = new THREE.Vector3();
      for (const id of world.moving()) layer.move(id, world.frame(id).clone().scale(s.setScalar((world.nodes.get(id)?.scale ?? 1_000_000) / 1_000_000)));
    },
    night: windowLife,
  };
  fetchIndex(base.href).then((index) => {
    const copies = Number(params.get('copies') ?? 1);
    layer = new ThingLayer({
      index, copies,
      hideRoofs: params.has('hideRoofs') && params.get('hideRoofs') !== '0', cut: params.has('cut') ? Number(params.get('cut')) : null,
      fetch: (h) => fetch(new URL(`worlds/models/${h}.glb`, base)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
    });
    out.layer = layer;
    scene.add(layer.group);
    for (const [n, r] of early.splice(0)) out.apply(n, r);
  });
  return out;
}

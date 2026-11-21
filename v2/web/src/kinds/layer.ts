// Things drawn from their kinds' entries (#3871): a thing with no baked model (one a creator places, any thing of a
// world with no bake: Mars, a created world) is drawn from its kind's `looks.shape` (shape.ts), in the state its node
// holds, the moment its kind's file arrives (catalogue.ts). A thing is one group of meshes that share geometry with
// every other thing of its kind in the same state, so a few hundred of them are cheap; Eden's baked things stay in
// the thing layer. The layer only observes: it draws where the world view puts each thing and moves nothing.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { buildShape, whenKey } from './shape.ts';
import { kindState } from './state.ts';
import type { Catalogue, KindEntry } from './catalogue.ts';

type Drawn = { node: NodeRec; entry: KindEntry; key: string; picture: THREE.Group; holder: THREE.Group };

export class KindLayer {
  readonly group = new THREE.Group();
  private drawn = new Map<string, Drawn>();
  /** The newest node and frame of a thing whose kind's file is on its way. */
  private waiting = new Map<string, { node: NodeRec; frame: THREE.Matrix4 }>();
  /** Things to draw again at the next `draw`: their node changed; and the things whose kind has a timed field. */
  private dirty = new Set<string>();
  private timed = new Set<string>();
  /** One picture per kind and `when` key, cloned for each thing (clones share geometry and materials). */
  private pictures = new Map<string, THREE.Group>();
  /** `onDrawn(id)`: the thing is now drawn here, so whatever stood in for it (a box) can go. */
  readonly catalogue: Catalogue;
  readonly onDrawn: (id: string) => void;
  constructor(catalogue: Catalogue, onDrawn: (id: string) => void = () => {}) {
    this.catalogue = catalogue;
    this.onDrawn = onDrawn;
    this.group.name = 'kinds';
  }

  /** Whether the thing is drawn from its kind here. */
  has(id: string): boolean { return this.drawn.has(id); }

  /** Places (or updates) a thing from its node, at `frame` (its frame in the world, scaled). */
  set(node: NodeRec, frame: THREE.Matrix4): void {
    const d = this.drawn.get(node.id);
    if (d && d.node.kind === node.kind) {
      d.node = node;
      d.holder.matrix.copy(frame);
      this.dirty.add(node.id);
      return;
    }
    if (d) this.remove(node.id);
    const first = !this.waiting.has(node.id);
    this.waiting.set(node.id, { node, frame });
    if (!first) return;
    this.catalogue.entry(node.kind).then((entry) => {
      const w = this.waiting.get(node.id);
      if (!w) return; // removed while its kind was on its way
      this.waiting.delete(node.id);
      if (w.node.kind !== node.kind) return void this.set(w.node, w.frame);
      if (!entry?.looks?.shape?.shapes?.length) return; // nothing to draw it from: its stand-in stays
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(w.frame);
      holder.name = `thing:${node.id}`;
      this.group.add(holder);
      this.drawn.set(node.id, { node: w.node, entry, key: '\0', picture: new THREE.Group(), holder });
      if (Object.values(entry.state ?? {}).some((f) => f.type === 'timed')) this.timed.add(node.id);
      this.onDrawn(node.id);
      this.refresh(node.id, null);
    });
  }

  /** Moves a drawn thing (what rides a course). */
  move(id: string, frame: THREE.Matrix4): void {
    const d = this.drawn.get(id);
    if (d) d.holder.matrix.copy(frame);
    else if (this.waiting.has(id)) this.waiting.get(id)!.frame = frame;
  }

  remove(id: string): void {
    this.waiting.delete(id);
    const d = this.drawn.get(id);
    if (!d) return;
    this.group.remove(d.holder);
    this.drawn.delete(id);
    this.dirty.delete(id);
    this.timed.delete(id);
  }

  /** The thing's state as its kind names it, at world time `t` (µs; null before the clock starts). */
  stateOf(id: string, t: number | null): Record<string, unknown> | null {
    const d = this.drawn.get(id);
    return d ? kindState(d.node.fields, d.entry.state ?? {}, t ?? undefined) : null;
  }

  /** Draws the things whose state may have changed (a new node, or a timed field) in their state at world time `t`. */
  draw(t: number | null): void {
    for (const id of this.dirty) this.refresh(id, t);
    this.dirty.clear();
    for (const id of this.timed) this.refresh(id, t);
  }

  /** The picture a thing has, for the looks (piece 4) and for tests: its root under the thing's frame. */
  picture(id: string): THREE.Group | null { return this.drawn.get(id)?.picture ?? null; }

  private refresh(id: string, t: number | null): void {
    const d = this.drawn.get(id)!, shape = d.entry.looks!.shape!;
    const state = kindState(d.node.fields, d.entry.state ?? {}, t ?? undefined);
    const key = whenKey(shape, state);
    if (key === d.key) return;
    const cacheKey = `${d.entry.kind}|${key}`;
    let proto = this.pictures.get(cacheKey);
    if (!proto) this.pictures.set(cacheKey, (proto = buildShape(shape, state)));
    d.holder.remove(d.picture);
    d.picture = proto.clone(true);
    d.holder.add(d.picture);
    d.key = key;
  }
}

// Every seat of Eden's seat kinds has a front: a Soul sits on the seat's surface, facing out of it, with its legs in
// front, and the engine's seat `n` is the seat the page draws it on. Checked against each seat def's own model, as the
// page draws it (`buildKit`), for every seat kind Eden 2026 places. Offline: no renderer, network or server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { coreLibrary, type StoredDef } from '@souls/world-compiler';
import { buildKit } from './kit.mesh.ts';
import { MaterialLib } from './materials.ts';
import { entriesIn, slotNumbers } from '../../../../v2/tools/import-eden/export/with.ts';

const root = new URL('../../../../', import.meta.url);
type Slot = StoredDef['slots'][number];
const isSeat = (s: Slot) => s.kind === 'seat';

/** Eden's seat kinds: every def the template places with a seat slot. */
function edenSeatDefs(): StoredDef[] {
  const refs = new Set<string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      if (r.op === 'place' && typeof r.def === 'string') refs.add(r.def);
      Object.values(r).forEach(walk);
    }
  };
  walk(JSON.parse(readFileSync(new URL('worlds/templates/eden-2026.json', root), 'utf8')));
  const lib = coreLibrary();
  return [...refs].sort().map((r) => lib.get(r)).filter((d): d is StoredDef => !!d && d.slots.some(isSeat));
}

/** The way a sitter faces, on the level: the thing's +z turned by the slot's yaw, as the page turns it (the v2 bridge's
 *  `sample`: a sitter faces out of its seat), the side its stand point is on. */
const facingOf = (yaw: number): [number, number] => [Math.sin(yaw), Math.cos(yaw)];

/** What is wrong with a sitter at `slot` facing `f` in `model` (its own frame, metres), or null: it lands on the seat's
 *  surface (the first thing straight below it is within a seat's thickness of its height, not an arm or a back above
 *  it); nothing is in front of its knees or its chest within 0.45 m (a backrest it would face, legs through it); and a
 *  backrest beside its chest (within 0.35 m on one side only, nearer than anything behind) is not there: it would sit
 *  sideways along the seat. Arms or chains on both sides alike are a seat between them, not a back. */
function seatFault(model: THREE.Object3D, slot: Slot, f: [number, number]): string | null {
  const [x, y, z] = slot.p, rc = new THREE.Raycaster();
  const cast = (o: number[], d: number[]) => { rc.set(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize()); rc.far = 5; return rc.intersectObject(model, true)[0]?.distance ?? null; };
  const down = cast([x, y + 0.3, z], [0, -1, 0]);
  if (down === null) return 'nothing under it';
  const surface = y + 0.3 - down - y;
  if (surface > 0.06 || surface < -0.15) return `the first thing under it is ${surface.toFixed(2)} m from the seat's height`;
  for (const h of [0.12, 0.38]) {
    const ahead = cast([x, y + h, z], [f[0], 0, f[1]]);
    if (ahead !== null && ahead < 0.45) return `something ${ahead.toFixed(2)} m in front of it at ${h} m above the seat`;
  }
  const chest = [x, y + 0.38, z];
  const behind = cast(chest, [-f[0], 0, -f[1]]) ?? Infinity;
  const [l, r] = [cast(chest, [f[1], 0, -f[0]]) ?? Infinity, cast(chest, [-f[1], 0, f[0]]) ?? Infinity];
  const side = Math.min(l, r);
  if (side < 0.35 && side < behind && Math.abs(l - r) > 0.05) return `a back ${side.toFixed(2)} m beside its chest, nothing nearer behind`;
  return null;
}

const modelOf = (d: StoredDef) => {
  const o = buildKit((d.make as { args: unknown }).args, { materials: new MaterialLib(), tint: (_k, fallback) => fallback, params: {}, state: {} });
  o.updateMatrixWorld(true);
  return o;
};

test("every seat of Eden's seat kinds faces out of its own model: on the seat, legs in front, back behind", () => {
  const defs = edenSeatDefs();
  // a vehicle's seat is in a cab or a hull its model draws no seat in (the locomotive's driver)
  const seats = defs.filter((d) => !d.tags.includes('vehicle'));
  for (const name of ['core-bench', 'core-chair', 'core-armchair', 'core-sofa', 'core-stool', 'core-bench-seat', 'core-pew', 'core-office-chair', 'core-theatre-seats', 'core-picnic-table']) {
    assert.ok(seats.some((d) => d.name === name), `${name} is one of Eden's seat kinds`);
  }
  const faults: string[] = [];
  for (const d of seats) {
    assert.equal(d.make.kind, 'gen', `${d.ref} is drawn by the kit`);
    const model = modelOf(d);
    for (const s of d.slots.filter(isSeat)) {
      const why = seatFault(model, s, facingOf(s.yaw));
      if (why) faults.push(`${d.ref} ${s.id}: ${why}`);
    }
  }
  assert.deepEqual(faults, []);
});

test("the check finds the seat turned wrong: sideways along the bench, as on soul.game, or into its back", () => {
  const bench = edenSeatDefs().find((d) => d.name === 'core-bench')!, model = modelOf(bench);
  const [left] = bench.slots.filter(isSeat);
  assert.equal(seatFault(model, left, facingOf(left.yaw)), null);
  assert.match(seatFault(model, left, facingOf(left.yaw + Math.PI / 2)) ?? '', /beside its chest/);
  assert.match(seatFault(model, left, facingOf(left.yaw - Math.PI / 2)) ?? '', /beside its chest/);
  assert.match(seatFault(model, left, facingOf(left.yaw + Math.PI)) ?? '', /in front of it/);
  // and on its end, over the arm: not on the seat's surface
  const end = { ...left, p: [-0.74, left.p[1], -0.02] as [number, number, number] };
  assert.match(seatFault(model, end, facingOf(end.yaw)) ?? '', /under it/);
});

test("each Eden seat kind's seat n, as the engine numbers its entry's slots, is the thing's own seat n the page draws", () => {
  const entries = entriesIn(new URL('content/kinds', root).pathname);
  const rows = (JSON.parse(readFileSync(new URL('content/worlds/eden/map.json', root), 'utf8')).rows as { def: string; entry?: string }[]);
  // the map names defs `core/<name>@<rev>`, the library `core-<name>@<rev>`; a kind with no row goes by its own name
  const entryOf = (d: StoredDef) => rows.find((r) => r.def.replace(/^core\//, 'core-') === d.ref)?.entry ?? `eden:${d.name.replace(/^core-/, '').replace(/-/g, '_')}`;
  type Entry = { kind: string; slots?: Record<string, { admits?: string; at_mm?: number[] }> };
  /** Each entry seat (the engine's seat `k`, the entry's order) the facts' numbering `number` puts on a slot of the
   *  thing other than its own seat nearest the entry's point. */
  const misdrawn = (number: (d: StoredDef, e: Entry) => Map<string, number>) => {
    const wrong: string[] = [];
    let checked = 0;
    for (const d of edenSeatDefs()) {
      const entry = entries.get(entryOf(d))?.entry as Entry | undefined;
      if (!entry?.slots) continue;
      const n = number(d, entry), own = d.slots.filter((s) => s.kind !== 'room');
      const bodies = own.filter((s) => s.kind === 'seat' || s.kind === 'bed');
      for (const [k, [name, e]] of Object.entries(entry.slots).entries()) {
        if (e.admits !== 'body' || !e.at_mm) continue;
        checked++;
        const at = e.at_mm.map((v) => v / 1000);
        const near = (s: Slot) => Math.hypot(s.p[0] - at[0], s.p[2] - at[2]);
        const nearest = bodies.reduce((a, b) => (near(b) < near(a) ? b : a), bodies[0]);
        const drawn = own.find((s) => n.get(s.id) === k + 1);
        if (drawn?.id !== nearest?.id) wrong.push(`${d.ref} ${name}: ${drawn ? `${drawn.kind} ${drawn.id}` : 'no slot'}`);
      }
    }
    assert.ok(checked > 40, `${checked} seats checked`);
    return wrong;
  };
  assert.deepEqual(misdrawn((d, e) => slotNumbers(d.slots, e)), []);
  // the def's own order, as the facts numbered every thing's slots before: a picnic or parasol table's seat 1 was its
  // top (a Soul sat on the table), and a canoe's and a narrowboat's places were swapped
  const before = misdrawn((d) => new Map(d.slots.map((s, i) => [s.id, i + 1])));
  for (const w of ['core-picnic-table@1 seat_1: surface top', 'core-parasol-table@1 seat_1: surface top', 'core-canoe@1 back: seat front', 'core-narrowboat@1 stern: bed berth']) {
    assert.ok(before.includes(w), `${w} in ${JSON.stringify(before)}`);
  }
});

// A world map's `with` rows as facts things (with.ts): Eden's guitar in its stand's cradle, its bass in its stand, a
// piano's bench beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { coreLibrary, type StoredDef } from '../../../../packages/world-compiler/src/index.ts';
import { entriesIn, slotNumbers, withMap, withThings } from './with.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entries = entriesIn(`${root}content/kinds`);
const withOf = withMap(`${root}content/worlds/eden/map.json`);
const place = (p: { x: number; y: number; z: number; yaw: number }) => [Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round(p.z * 1000), Math.round((p.yaw * 180_000) / Math.PI)];

test("Eden's map holds a guitar in each guitar stand's cradle and a bass in each bass stand's", () => {
  for (const [def, holder, made] of [['eden-guitar-stand@1', 'eden:guitar_stand', 'eden:guitar'], ['eden-bass-stand@1', 'eden:bass_stand', 'eden:bass_guitar']]) {
    const rows = withOf(def);
    assert.equal(rows.length, 1, def);
    const [w] = withThings({ id: 'e_stand', name: 'stage-guitar', entry: holder, parent: null, pose: { x: 89.9, y: 0, z: -30.3, yaw: Math.PI }, world: { x: 89.9, y: 0, z: -30.3, yaw: Math.PI }, scale: 1 }, rows, entries, place);
    assert.deepEqual(w.thing, { id: 'e_stand-with-1', def: made, ref: `entry:${made}`, name: `stage-guitar-${made.split(':')[1]}`, entry: made, scale_ppm: 1_000_000,
      parent: 'e_stand', slot: { n: 1, id: 'cradle' }, pose: [0, 300, 0, 0], world: [89900, 300, -30300, 180000] }, 'in the cradle, slot 1 as the stand\'s entry numbers it, at its point');
    assert.deepEqual(w.slot, { n: 1, id: 'cradle', kind: 'thing', at: [0, 300, 0], yaw: 0 }, 'the stand\'s slot, which its def does not bake');
    assert.equal(w.kind.name, made, 'a kind named as its entry, so the world pins it and the stand\'s take finds it');
    assert.match(w.kind.hash, /^[0-9a-f]{64}$/);
  }
});

test("a piano's bench stands beside it, in its room, turned with it", () => {
  const rows = withOf('core/piano@1');
  assert.equal(rows[0]?.entry, 'eden:piano_bench');
  const [w] = withThings({ id: 'e_piano', name: 'parlour-piano', entry: 'eden:piano', parent: 'e_house', slot: { room: 'parlour' }, pose: { x: 1, y: 0, z: 2, yaw: Math.PI / 2 }, world: { x: 11, y: 0, z: 22, yaw: Math.PI / 2 }, scale: 1 }, rows, entries, place);
  // at_mm [0, 0, 650] in the piano's frame: its +z is the room's +x when it is turned a quarter
  assert.deepEqual(w.thing.pose, [1650, 0, 2000, 90_000]);
  assert.deepEqual(w.thing.world, [11650, 0, 22000, 90_000]);
  assert.deepEqual([w.thing.parent, w.thing.slot], ['e_house', { room: 'parlour' }], "the piano's own parent and room");
  const [inSlot] = withThings({ id: 'e_piano', entry: 'eden:piano', parent: 'e_shelf', slot: { n: 2, id: 'top' }, pose: { x: 0, y: 0, z: 0, yaw: 0 }, world: { x: 0, y: 0, z: 0, yaw: 0 }, scale: 1 }, rows, entries, place);
  assert.equal(inSlot.thing.slot, undefined, 'never into a slot one thing holds: a plain child at its own place');
});

test('a row naming an entry or a slot the content does not have is refused', () => {
  const holder = { id: 'e_x', entry: 'eden:guitar_stand', parent: null, pose: { x: 0, y: 0, z: 0, yaw: 0 }, world: { x: 0, y: 0, z: 0, yaw: 0 }, scale: 1 };
  assert.throws(() => withThings(holder, [{ entry: 'eden:no_such_thing', slot: 'cradle' }], entries, place), /does not have/);
  assert.throws(() => withThings(holder, [{ entry: 'eden:guitar', slot: 'shelf' }], entries, place), /does not have/);
  assert.deepEqual(withOf('core-chair@1'), [], 'a row without `with` adds nothing');
});

type Slot = StoredDef['slots'][number];

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
  walk(JSON.parse(readFileSync(`${root}worlds/templates/eden-2026.json`, 'utf8')));
  const lib = coreLibrary();
  return [...refs].sort().map((r) => lib.get(r)).filter((d): d is StoredDef => !!d && d.slots.some((s) => s.kind === 'seat'));
}

test("each Eden seat kind's seat n, as the engine numbers its entry's slots, is the thing's own seat n the page draws", () => {
  const rows = (JSON.parse(readFileSync(`${root}content/worlds/eden/map.json`, 'utf8')).rows as { def: string; entry?: string }[]);
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

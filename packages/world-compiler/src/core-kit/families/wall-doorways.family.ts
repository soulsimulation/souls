// #2383 doors everywhere. Every core building (gen building/1) gets one new immutable revision, its newest of 14 Nov 2026 plus one, that
// sets make.args.doorThings (the versions are pinned in DOOR_FITTED_VERSIONS): each ground-floor doorway is then bare (no drawn leaf), and a real hand-operated door
// (core/door@2) set in it is the door (packages/generators building-doors.ts places them; templates carry them and the
// door-fit/1 boot rule fits them in live worlds). Walls, colliders, openings, rooms and slots are the older revision's
// for the same params; only the drawn leaves go. Older revisions keep their bytes.
import structures from '../structures.json' with { type: 'json' };
import vocabW3 from '../vocab-w3.json' with { type: 'json' };
import hallBareDoor from '../hall-bare-door.json' with { type: 'json' };
import type { DefInput } from '../../schemas.ts';

type Def = DefInput & { name: string; version: number; make: { kind: string; gen?: string; args?: Record<string, unknown> }; description?: string };
/** core-hall@2 (#2282, bare doorways) lives in its own file: structures.json is part of the frozen historical corpus (legacy.ts). */
export const HALL_BARE_DOOR = hallBareDoor as unknown as DefInput[];
const all = [...structures, ...vocabW3, ...hallBareDoor] as unknown as Def[];

/** The door-fitted revision of each core building def, pinned (review of #2397): a def revision that lands later never
 *  renumbers these. Each builds on the revision just before it (core-hall@3 on core-hall@2's bareDoors). */
export const DOOR_FITTED_VERSIONS: Readonly<Record<string, number>> = {
  "core-cottage": 2, "core-roundhouse": 2, "core-townhouse": 2, "core-shop": 2,
  "core-hall": 3, "core-chapel": 2, "core-barn": 2, "core-shed": 2,
  "core-greenhouse": 2, "core-pavilion": 2, "core-tower": 2, "core-lighthouse": 2,
  "core-house": 2, "core-apartment-block": 2, "core-townhouse-row": 2, "core-cabin": 2,
  "core-mansion": 2, "core-dormitory": 2, "core-hotel": 2, "core-mobile-home": 2,
  "core-corner-shop": 2, "core-supermarket": 2, "core-restaurant": 2, "core-cafe": 2,
  "core-bar": 2, "core-bank": 2, "core-office-block": 2, "core-mall": 2,
  "core-garage": 2, "core-petrol-station": 2, "core-school": 2, "core-hospital": 2,
  "core-library": 2, "core-town-hall": 2, "core-police-station": 2, "core-fire-station": 2,
  "core-church": 2, "core-prison": 2, "core-theatre": 2, "core-museum": 2,
};
const base = new Map(Object.entries(DOOR_FITTED_VERSIONS).map(([name, v]) => {
  const d = all.find((x) => x.name === name && x.version === v - 1 && x.make?.kind === 'gen' && x.make.gen === 'building/1');
  if (!d) throw new Error(`wall-doorways: ${name}@${v - 1} is not a building/1 def`);
  return [name, d] as const;
}));

/** The door-fitted revisions, one per core building def. */
export const DOOR_FITTED_BUILDINGS: DefInput[] = [...base.values()].map((d) => {
  const x = structuredClone(d);
  return { ...x, version: DOOR_FITTED_VERSIONS[d.name]!, make: { ...x.make, args: { ...x.make.args, doorThings: true } },
    description: `${d.description ?? ''} Its ground-floor doorways are bare: a real door (core/door@2) in each is the door, and a Soul opens it by hand.`.trim() } as DefInput;
});

/** Each fitted revision by the ref it replaces (`core/cottage@1` → `core/cottage@2`), with its make args and whether its
 *  rooms are enclosed (their doors start closed). core/hall@2 (#2282) already carries its doors in its two Eden doorways,
 *  so it is not replaced. */
export const DOOR_FIT_FROM: ReadonlyMap<string, { ref: string; args: Record<string, unknown>; enclosed: boolean }> = new Map(
  all.filter((d) => base.has(d.name) && d.version < DOOR_FITTED_VERSIONS[d.name]! && !d.make.args?.bareDoors).map((d) => {
    const ref = (v: number) => `core/${d.name.replace(/^core-/, '')}@${v}`, to = base.get(d.name)!;
    const place = (d as unknown as { components?: { place?: { enclosed?: boolean } } }).components?.place;
    return [ref(d.version), { ref: ref(DOOR_FITTED_VERSIONS[d.name]!), args: { ...to.make.args, doorThings: true }, enclosed: place?.enclosed !== false }];
  }));
export default [...HALL_BARE_DOOR, ...DOOR_FITTED_BUILDINGS];

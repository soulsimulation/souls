// #2434 every doorway a real door. Each door-fitted core building revision (wall-doorways.family.ts, outside ground-floor
// doors only) gets one more immutable revision, pinned in ALL_DOORS_VERSIONS, that sets make.args.doorThings to 2: EVERY
// doorway is then bare (inside, upstairs, onto a balcony) and a real hand-operated door (core/door@2) set in it is the
// door (packages/generators building-doors.ts; templates carry them and the door-fit/2 boot rule fits them in live
// worlds). An inside doorway is made as wide as an outside one where its wall has room (1.2 m), so the door's frame
// stands clear of its jambs; walls, rooms, stairs and slots are otherwise the revision before's. Older revisions keep
// their bytes.
import type { DefInput } from '../../schemas.ts';
import { DOOR_FIT_FROM, DOOR_FITTED_BUILDINGS, DOOR_FITTED_VERSIONS } from './wall-doorways.family.ts';

type Def = DefInput & { name: string; version: number; make: { kind: string; gen?: string; args?: Record<string, unknown> }; description?: string };

/** The every-doorway revision of each core building def, pinned: the door-fitted revision plus one. */
export const ALL_DOORS_VERSIONS: Readonly<Record<string, number>> = Object.fromEntries(Object.entries(DOOR_FITTED_VERSIONS).map(([name, v]) => [name, v + 1]));

/** The every-doorway revisions, one per core building def, each built on its door-fitted revision. */
export const ALL_DOORS_BUILDINGS: DefInput[] = (DOOR_FITTED_BUILDINGS as Def[]).map((d) => {
  const x = structuredClone(d);
  return { ...x, version: ALL_DOORS_VERSIONS[d.name]!, make: { ...x.make, args: { ...x.make.args, doorThings: 2 } },
    description: `${(d.description ?? '').replace(/ Its ground-floor doorways are bare:.*$/, '')} Every doorway is bare: a real door (core/door@2) in each, inside and upstairs too, is the door, and a Soul opens it by hand.`.trim() } as DefInput;
});
/** Each every-doorway revision by the refs it replaces: the first revision and the door-fitted one (`core/cottage@1` and
 *  `core/cottage@2` → `core/cottage@3`), with its make args and whether its rooms are enclosed (its outside doors start
 *  closed). core/hall@2 (#2282) keeps the doors it already carries, as door-fit/1 does. */
export const ALL_DOORS_FROM: ReadonlyMap<string, { ref: string; args: Record<string, unknown>; enclosed: boolean }> = new Map(
  [...DOOR_FIT_FROM].flatMap(([from, to]) => {
    const name = `core-${to.ref.replace(/^core\//, '').replace(/@\d+$/, '')}`, v = ALL_DOORS_VERSIONS[name]!, ref = `core/${name.slice(5)}@${v}`;
    const next = { ref, args: { ...to.args, doorThings: 2 }, enclosed: to.enclosed };
    return [[from, next], [to.ref, next]] as [string, typeof next][];
  }));
export default ALL_DOORS_BUILDINGS;

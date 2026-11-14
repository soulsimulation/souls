// #2383 doors everywhere. Every core building (gen building/1) gets one new immutable revision, its newest plus one, that
// sets make.args.doorThings: each ground-floor doorway is then bare (no drawn leaf), and a real hand-operated door
// (core/door@2) set in it is the door (packages/generators building-doors.ts places them; templates carry them and the
// door-fit/1 boot rule fits them in live worlds). Walls, colliders, openings, rooms and slots are the older revision's
// for the same params; only the drawn leaves go. Older revisions keep their bytes.
import structures from '../structures.json' with { type: 'json' };
import vocabW3 from '../vocab-w3.json' with { type: 'json' };
import type { DefInput } from '../../schemas.ts';

type Def = DefInput & { name: string; version: number; make: { kind: string; gen?: string; args?: Record<string, unknown> }; description?: string };
const all = [...structures, ...vocabW3] as unknown as Def[];
const newest = new Map<string, Def>();
for (const d of all) if (d.make?.kind === 'gen' && d.make.gen === 'building/1' && (newest.get(d.name)?.version ?? 0) < d.version) newest.set(d.name, d);

/** The door-fitted revisions, one per core building def (core-hall@3 builds on core-hall@2's bareDoors). */
export const DOOR_FITTED_BUILDINGS: DefInput[] = [...newest.values()].map((d) => {
  const x = structuredClone(d);
  return { ...x, version: d.version + 1, make: { ...x.make, args: { ...x.make.args, doorThings: true } },
    description: `${d.description ?? ''} Its ground-floor doorways are bare: a real door (core/door@2) in each is the door, and a Soul opens it by hand.`.trim() } as DefInput;
});

/** Each fitted revision by the ref it replaces (`core/cottage@1` → `core/cottage@2`), with its make args and whether its
 *  rooms are enclosed (their doors start closed). core/hall@2 (#2282) already carries its doors in its two Eden doorways,
 *  so it is not replaced. */
export const DOOR_FIT_FROM: ReadonlyMap<string, { ref: string; args: Record<string, unknown>; enclosed: boolean }> = new Map(
  all.filter((d) => newest.has(d.name) && !d.make.args?.bareDoors).map((d) => {
    const ref = (v: number) => `core/${d.name.replace(/^core-/, '')}@${v}`, to = newest.get(d.name)!;
    const place = (d as unknown as { components?: { place?: { enclosed?: boolean } } }).components?.place;
    return [ref(d.version), { ref: ref(to.version + 1), args: { ...to.make.args, doorThings: true }, enclosed: place?.enclosed !== false }];
  }));
export default DOOR_FITTED_BUILDINGS;

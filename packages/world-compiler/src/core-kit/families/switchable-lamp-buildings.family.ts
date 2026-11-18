// #2953 switchable floor lamps in furnished buildings. core-house@3 and core-church@3 (wall-doorways-all.family.ts) furnish
// their rooms with core/floor-lamp@1, which has no actions. Each gets one new immutable revision, pinned in
// SWITCHABLE_LAMP_VERSIONS, that is its every-doorway revision with those lamps on core/floor-lamp@2 (switch-on and
// switch-off, switchable-lights.ts); walls, doors, rooms and every other part of its contents are the revision before's.
// Older revisions keep their bytes.
import type { DefInput } from '../../schemas.ts';
import { ALL_DOORS_BUILDINGS, ALL_DOORS_VERSIONS } from './wall-doorways-all.family.ts';

type Def = DefInput & { name: string; version: number; description?: string; contents?: { def: string }[] };

/** The switchable-lamp revision of each building whose contents place a floor lamp: its every-doorway revision plus one. */
export const SWITCHABLE_LAMP_VERSIONS: Readonly<Record<string, number>> = { 'core-house': 4, 'core-church': 4 };

export const SWITCHABLE_LAMP_BUILDINGS: DefInput[] = Object.entries(SWITCHABLE_LAMP_VERSIONS).map(([name, v]) => {
  const d = (ALL_DOORS_BUILDINGS as Def[]).find((x) => x.name === name && x.version === ALL_DOORS_VERSIONS[name]);
  if (!d || ALL_DOORS_VERSIONS[name] !== v - 1) throw new Error(`switchable-lamp-buildings: ${name}@${v - 1} is not its every-doorway revision`);
  const x = structuredClone(d);
  return { ...x, version: v, contents: x.contents!.map((c) => (c.def === 'core/floor-lamp@1' ? { ...c, def: 'core/floor-lamp@2' } : c)),
    description: `${d.description ?? ''} Its floor lamps can be switched on and off.`.trim() } as DefInput;
});
export default SWITCHABLE_LAMP_BUILDINGS;

// soul-catalog/1 (#1737): the world's structure as one public file a Soul's client keeps on disk and searches locally:
// places, things, and the acts that can be sent by id from anywhere. Pure: no clock, no Soul, no availability. What is
// free, open or taken right now is live state and is not here; the server still decides every act when it is sent.
import {hashOf, stableStringify} from '@souls/engine-contract';

export const CATALOG_CONTRACT = 'soul-catalog/1';
/** Verbs every walkable place takes by its id (`walk:<place>`). Offered on demand by id wherever the Soul stands. */
export const PLACE_VERBS = ['walk', 'jog', 'run', 'hang-out', 'stroll', 'gather'] as const;

/** What a body can do right where it stands, sent as `<verb>:here`. These need no place or thing, so no search by
 *  place finds them; the catalog names them so that "sit down on the floor" is found like anything else. Whether one is
 *  open to a Soul this minute (a ride's rider, a body that cannot dance) is the world's to say when it is sent. */
export const ANYWHERE: readonly (readonly [string, string])[] = [
  ['sit-ground', 'Sit down on the ground or floor, right here'], ['lie', 'Lie down right here'], ['nap', 'Take a nap right here'],
  ['rest', 'Rest here'], ['stand', 'Stand up and stop what you are doing'], ['wander', 'Stroll around nearby'], ['wave', 'Wave'],
  ['dance', 'Dance here'], ['jump', 'Jump on the spot'], ['stretch', 'Stretch'], ['jumping-jacks', 'Do jumping jacks'], ['yoga', 'Do yoga'],
  ['pushups', 'Do push-ups'], ['situps', 'Do sit-ups'], ['bow', 'Bow'], ['clap', 'Clap or applaud'], ['nod', 'Nod'],
  ['shake-head', 'Shake your head'], ['cheer', 'Cheer'], ['point', 'Point at someone or something']];

type V2 = readonly [number, number];
export type CatalogPlaceIn = {id: string; name: string; kind: string; parent: string | null; level: number; polygon: readonly V2[]; aliases?: readonly string[]; description?: string; ref?: string; secret?: boolean; carrier?: unknown};
export type CatalogSpotIn = {id: string; place?: string; activity: string; also?: readonly string[]; at: V2; label?: string; title?: string; together?: {need: number}; requires?: string};
export type CatalogThingIn = {id: string; kind: string; name: string; at: V2; place: string | null; seat?: boolean};
export type CatalogInput = {worldId: string; places: readonly CatalogPlaceIn[]; spots: readonly CatalogSpotIn[]; things: readonly CatalogThingIn[]};

export type CatalogPlace = {id: string; ref?: string; name: string; kind: string; parent: string | null; at: [number, number]; level?: number; aliases?: string[]; what?: string; fixed?: true};
/** `seat`: the thing has a seat a body sits on, so `sit:<id>` is an act the world takes from anywhere. */
export type CatalogThing = {id: string; name: string; kind: string; place: string | null; at: [number, number]; seat?: true};
export type CatalogAct = {id: string; verb: string; place: string | null; thing?: string; at: [number, number]; label: string; with?: number; needs?: string};
export type Catalog = {contract: typeof CATALOG_CONTRACT; worldId: string; scope: 'public'; placeVerbs: readonly string[]; anywhere: {id: string; verb: string; label: string}[];
  places: CatalogPlace[]; things: CatalogThing[]; acts: CatalogAct[]; counts: {places: number; things: number; acts: number; kinds: number}};

const r1 = (n: number) => Math.round(n * 10) / 10;
const centre = (poly: readonly V2[]): [number, number] => [r1(poly.reduce((s, v) => s + v[0], 0) / poly.length), r1(poly.reduce((s, v) => s + v[1], 0) / poly.length)];
/** A thing's kind as people name it: `ew:core-bowl@1:c56a7cb231` (entity-world def, revision, params hash) is `core-bowl`. */
export const kindOf = (def: string) => def.replace(/^ew:/, '').replace(/@\d+(?::[0-9a-f]+)?$/, '');
const byId = (a: {id: string}, b: {id: string}) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** The entity a spot belongs to: spot ids are `<activity>.<entity id>[.<n>]`. */
export const spotThing = (id: string) => /(?:^|\.)(e_[0-9a-z]+)(?:\.|$)/.exec(id)?.[1];

/** The catalog and its canonical bytes. Same input, same bytes, same tag. Every fact here is `public`: the scope field is
 *  where a later privacy model withholds, entry by entry, without a new contract. */
export function buildCatalog(input: CatalogInput): {payload: Catalog; serialized: string; etag: string; version: string} {
  if (!input.worldId) throw Error('catalog.invalid: worldId');
  // a ref is published only when it names one place: a lake and its bank can share one, and `walk:<ref>` would then name
  // neither (the world refuses it), while the id always names its place
  const refs = new Map<string, number>(); for (const p of input.places) if (p.ref) refs.set(p.ref, (refs.get(p.ref) ?? 0) + 1);
  const places: CatalogPlace[] = input.places.filter(p => !p.secret && p.polygon.length >= 1).map(p => ({
    id: p.id, ...(p.ref && p.ref !== p.id && refs.get(p.ref) === 1 ? {ref: p.ref} : {}), name: p.name, kind: p.kind, parent: p.parent, at: centre(p.polygon), ...(p.level ? {level: p.level} : {}),
    ...(p.aliases?.length ? {aliases: [...p.aliases]} : {}), ...(p.description ? {what: p.description.slice(0, 200)} : {}), ...(p.carrier ? {fixed: true as const} : {})})).sort(byId);
  const known = new Set(input.places.filter(p => !p.secret).map(p => p.id));
  const things: CatalogThing[] = input.things.filter(t => !t.place || known.has(t.place)).map(t => ({id: t.id, name: t.name, kind: kindOf(t.kind), place: t.place, at: [r1(t.at[0]), r1(t.at[1])] as [number, number], ...(t.seat ? {seat: true as const} : {})})).sort(byId);
  const acts: CatalogAct[] = [];
  for (const s of input.spots) {
    if (s.place && !known.has(s.place)) continue;
    const thing = spotThing(s.id), where = s.label ?? s.place ?? s.id;
    for (const verb of [s.activity, ...(s.also ?? [])]) acts.push({id: `${verb}:${s.id}`, verb, place: s.place ?? null, ...(thing ? {thing} : {}), at: [r1(s.at[0]), r1(s.at[1])],
      label: verb === s.activity && s.title ? `${s.title} (${where})` : `${verb.replace(/-/g, ' ')} (${where})`, ...(s.together ? {with: s.together.need} : {}), ...(s.requires ? {needs: s.requires} : {})});
  }
  acts.sort(byId);
  const payload: Catalog = {contract: CATALOG_CONTRACT, worldId: input.worldId, scope: 'public', placeVerbs: PLACE_VERBS, anywhere: ANYWHERE.map(([verb, label]) => ({id: `${verb}:here`, verb, label})), places, things, acts,
    counts: {places: places.length, things: things.length, acts: acts.length, kinds: new Set(things.map(t => t.kind)).size}};
  const serialized = stableStringify(payload), version = hashOf(payload);
  return {payload, serialized, etag: `"${version}"`, version};
}

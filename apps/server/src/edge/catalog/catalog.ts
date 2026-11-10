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
/** #1751: an act a kind of thing takes by hand, sent as `object:<thing>:<verb>`; `when` is the state it needs. */
export type CatalogKindAct = {verb: string; label: string; params?: Record<string, unknown>; when?: {field: string; is?: unknown; not?: unknown}[]};
export type CatalogThingIn = {id: string; kind: string; name: string; at: V2; place: string | null; hand?: {acts: readonly CatalogKindAct[]; state: Record<string, unknown>} | null};
export type CatalogInput = {worldId: string; places: readonly CatalogPlaceIn[]; spots: readonly CatalogSpotIn[]; things: readonly CatalogThingIn[]};

export type CatalogPlace = {id: string; ref?: string; name: string; kind: string; parent: string | null; at: [number, number]; level?: number; aliases?: string[]; what?: string; fixed?: true};
export type CatalogThing = {id: string; name: string; kind: string; place: string | null; at: [number, number]; /** false: this one takes none of its kind's acts */ byHand?: false};
export type CatalogAct = {id: string; verb: string; place: string | null; thing?: string; at: [number, number]; label: string; with?: number; needs?: string};
export type Catalog = {contract: typeof CATALOG_CONTRACT; worldId: string; scope: 'public'; placeVerbs: readonly string[]; anywhere: {id: string; verb: string; label: string}[];
  places: CatalogPlace[]; things: CatalogThing[]; acts: CatalogAct[];
  /** #1751: per kind of thing, the acts it takes by hand (`object:<thing id>:<verb>`). Only kinds that take any. */
  kinds: Record<string, {acts: CatalogKindAct[]; state: Record<string, unknown>}>;
  counts: {places: number; things: number; acts: number; kinds: number; handKinds: number; handThings: number}};

const r1 = (n: number) => Math.round(n * 10) / 10;
const centre = (poly: readonly V2[]): [number, number] => [r1(poly.reduce((s, v) => s + v[0], 0) / poly.length), r1(poly.reduce((s, v) => s + v[1], 0) / poly.length)];
/** A thing's kind as people name it: `ew:core-bowl@1:c56a7cb231` (entity-world def, revision, params hash) is `core-bowl`. */
export const kindOf = (def: string) => def.replace(/^ew:/, '').replace(/@\d+(?::[0-9a-f]+)?$/, '');
const byId = (a: {id: string}, b: {id: string}) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** The entity a spot belongs to: spot ids are `<activity>.<entity id>[.<n>]`. */
const spotThing = (id: string) => /(?:^|\.)(e_[0-9a-z]+)(?:\.|$)/.exec(id)?.[1];

/** The catalog and its canonical bytes. Same input, same bytes, same tag. Every fact here is `public`: the scope field is
 *  where a later privacy model withholds, entry by entry, without a new contract. */
export function buildCatalog(input: CatalogInput): {payload: Catalog; serialized: string; etag: string; version: string} {
  if (!input.worldId) throw Error('catalog.invalid: worldId');
  const places: CatalogPlace[] = input.places.filter(p => !p.secret && p.polygon.length >= 1).map(p => ({
    id: p.id, ...(p.ref && p.ref !== p.id ? {ref: p.ref} : {}), name: p.name, kind: p.kind, parent: p.parent, at: centre(p.polygon), ...(p.level ? {level: p.level} : {}),
    ...(p.aliases?.length ? {aliases: [...p.aliases]} : {}), ...(p.description ? {what: p.description.slice(0, 200)} : {}), ...(p.carrier ? {fixed: true as const} : {})})).sort(byId);
  const known = new Set(input.places.filter(p => !p.secret).map(p => p.id));
  const shown = input.things.filter(t => !t.place || known.has(t.place));
  const things: CatalogThing[] = shown.map(t => ({id: t.id, name: t.name, kind: kindOf(t.kind), place: t.place, at: [r1(t.at[0]), r1(t.at[1])] as [number, number]})).sort(byId);
  // one entry per kind: revisions of a kind that differ add their verbs (the world still decides each act when it is sent)
  // (`state`: what a thing of the kind is in until the live picture says otherwise)
  const handKinds = new Map<string, {acts: Map<string, CatalogKindAct>; state: Record<string, unknown>}>(); let handThings = 0;
  for (const t of shown) {
    if (!t.hand?.acts.length) continue; handThings++;
    const k = kindOf(t.kind), m = handKinds.get(k) ?? {acts: new Map<string, CatalogKindAct>(), state: {}}; handKinds.set(k, m);
    for (const a of t.hand.acts) if (!m.acts.has(a.verb)) m.acts.set(a.verb, a);
    for (const [f, v] of Object.entries(t.hand.state)) if (!(f in m.state)) m.state[f] = v;
  }
  // a thing of a revision that takes no acts, where another revision of its kind does
  const bare = new Set(shown.filter(t => !t.hand?.acts.length && handKinds.has(kindOf(t.kind))).map(t => t.id));
  for (const t of things) if (bare.has(t.id)) t.byHand = false;
  const kinds: Catalog['kinds'] = Object.fromEntries([...handKinds].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, m]) => [k, {acts: [...m.acts.values()], state: m.state}]));
  const acts: CatalogAct[] = [];
  for (const s of input.spots) {
    if (s.place && !known.has(s.place)) continue;
    const thing = spotThing(s.id), where = s.label ?? s.place ?? s.id;
    for (const verb of [s.activity, ...(s.also ?? [])]) acts.push({id: `${verb}:${s.id}`, verb, place: s.place ?? null, ...(thing ? {thing} : {}), at: [r1(s.at[0]), r1(s.at[1])],
      label: verb === s.activity && s.title ? `${s.title} (${where})` : `${verb.replace(/-/g, ' ')} (${where})`, ...(s.together ? {with: s.together.need} : {}), ...(s.requires ? {needs: s.requires} : {})});
  }
  acts.sort(byId);
  const payload: Catalog = {contract: CATALOG_CONTRACT, worldId: input.worldId, scope: 'public', placeVerbs: PLACE_VERBS, anywhere: ANYWHERE.map(([verb, label]) => ({id: `${verb}:here`, verb, label})), places, things, acts, kinds,
    counts: {places: places.length, things: things.length, acts: acts.length, kinds: new Set(things.map(t => t.kind)).size, handKinds: handKinds.size, handThings}};
  const serialized = stableStringify(payload), version = hashOf(payload);
  return {payload, serialized, etag: `"${version}"`, version};
}

// #2528 A1: an act's place capability (explicitPlaceCapability) builds the Soul's known places once, the whole menu only
// when a refusal needs its "did you mean" list, and no walk offer it does not read (an id that is a known place's: that
// place's walks and the thing walks whose label could be the id, placeIdWalks). The oracle: over a corpus from Eden
// 2026 (every offered walk id, known places by id that are not offered, unknown ids and words, and ambiguous words: names
// two places share, and things whose walk label is also a place's name or alias), the capability or refusal, with its code
// and did_you_mean list, equals the path as it was before (frozen below, verbatim but for imports).
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {bootEden} from '../../../test/eden-capabilities-timing.ts';
import type {EdgeLedger} from '../ledger/ledger.ts';
import type {EdgeCapability, EdgeSoul} from '../contract.ts';
import {ID_SHAPED, knownIds, type StrictRefusal} from '../intents/strict.ts';
import {menuStats} from '../ledger/menu-stats.ts';
import {explicitPlaceCapability, knownBootPlaces, offersOfVerb, bootAliases, nativeAliasesOf} from './world-places.ts';
import {resolveBootPlace, normalizedPlaceName, type KnownBootPlace, type DestinationCapability} from './place-resolution.ts';

const NO_EDEN = existsSync(new URL('../../../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json';

// ---------------------------------------------------------------- the path before #2528 (frozen)
function oldKnownBootPlaces(L: EdgeLedger, soulId?: string): KnownBootPlace[] {
  const regions = L.host.engine.world.regions, aliases = new Map(nativeAliasesOf(L).map(a => [a.place, a.nativeRegion])), names = bootAliases(L);
  return [...L.places.byId.values()].filter(p => soulId === undefined || (L.knowledge?.knows(soulId, p.id) ?? true)).map(p => {const id = aliases.get(p.id) ?? p.id, r = regions[id] as (typeof regions)[string] & {placeLevel?: number} | undefined, admitted = !!r && (r.placeLevel ?? r.level ?? 0) === p.level, god = !r && !p.carrier && !!L.placeWalkable?.(p.id);
    return {id: p.id, name: p.name, aliases: [...new Set([...(names[p.id] ?? []), ...(p.aliases ?? [])])], level: p.level, nativeRegion: admitted ? id : null, access: p.carrier ? 'dynamic-carrier' : admitted || god ? 'admitted' : p.level !== 0 ? 'unsupported-floor' : 'scenery'};
  });
}
function oldStrictCheck(ledger: EdgeLedger, soul: EdgeSoul, input: string, caps: EdgeCapability[]): StrictRefusal | null {
  const i = input.indexOf(':'); if (i <= 0) return null;
  const verb = input.slice(0, i).trim().toLowerCase(), target = input.slice(i + 1).trim();
  if (!ID_SHAPED.test(target) || caps.some(c => c.id === input)) return null;
  if (verb === 'accept' || verb === 'decline') return null;
  const known = knownIds(ledger, caps); if (known.has(target)) return null;
  const words = target.split(/[-._]+/).filter(w => w.length > 2 && w !== 'eden');
  const score = (c: EdgeCapability) => (c.verb === verb ? 10 : 0) + (c.target?.kind === 'place' ? 2 : 0) + words.filter(w => (c.id + ' ' + c.label).toLowerCase().includes(w)).length * 3 + (c.available ? 1 : 0);
  const did = caps.filter(c => words.some(w => (c.id + ' ' + c.label).toLowerCase().includes(w)) || c.verb === verb).map(c => ({c, s: score(c)}))
    .sort((a, b) => b.s - a.s || a.c.id.localeCompare(b.c.id)).slice(0, 5).map(({c}) => ({id: c.id, label: c.label}));
  void soul;
  return {code: 'capability.unknown', reason: `"${target}" is not an id in this world (no place, Soul or thing has it), so nothing was done. Use an id from capabilities or the map, or say it in plain words.`, did_you_mean: did};
}
const destinationOffers = (caps: readonly EdgeCapability[], verb: string): DestinationCapability[] => caps.filter(c => c.verb === verb && c.target?.kind === 'place').map(c => ({id: c.id, placeId: c.target!.id, available: c.available, blocked: c.blocked}));
function oldResolvePlaceForVerb(L: EdgeLedger, soul: EdgeSoul, input: unknown, verb = 'walk') {
  const caps = offersOfVerb(L, soul, verb), offers = destinationOffers(caps, verb);
  const places = oldKnownBootPlaces(L, soul.soulId);
  let resolved = resolveBootPlace(input, places, offers, 'auto', false);
  if (!resolved.ok && verb === 'walk' && resolved.code === 'place.unwalkable' && L.walkOnDemand) {
    const named = resolveBootPlace(input, places, places.map(p => ({placeId: p.id, id: p.id, available: true})), 'auto', false), more = [...caps];
    if (named.ok && places.find(p => p.id === named.chosen.place)?.access === 'admitted' && L.walkOnDemand(soul, named.chosen.place, more, new Map())) {const again = resolveBootPlace(input, places, destinationOffers(more, verb), 'auto', false); if (again.ok) resolved = again;}
  }
  if (!resolved.ok) resolved = resolveBootPlace(input, places, offers);
  if (!resolved.ok && verb === 'walk' && resolved.code === 'place.unwalkable') {
    const named = resolveBootPlace(input, places, places.map(p => ({placeId: p.id, id: p.id, available: true})), 'auto', false), near = named.ok ? oldNearestOffer(L, named.chosen.place, offers) : null;
    return {...resolved, reason: resolved.reason.replace(/; refresh capabilities\.$/, '.') + ` No walk reaches it from the destinations offered now${near ? `; the nearest place one reaches is ${near.label} (${near.id})` : ''}.`, ...(near ? {next: near.id} : {})};
  }
  return resolved;
}
function oldNearestOffer(L: EdgeLedger, placeId: string, offers: readonly DestinationCapability[]) {
  const centre = (id: string) => {const p = L.places.byId.get(id)?.polygon; return p?.length ? [p.reduce((s, v) => s + v[0], 0) / p.length, p.reduce((s, v) => s + v[1], 0) / p.length] as const : null;}, at = centre(placeId); if (!at) return null;
  let best: {id: string; label: string; d: number} | null = null;
  for (const o of offers) {if (o.placeId === placeId || !o.available) continue; const c = centre(o.placeId); if (!c) continue; const d = Math.hypot(c[0] - at[0], c[1] - at[1]); if (!best || d < best.d) best = {id: o.id, label: L.places.byId.get(o.placeId)!.name, d};}
  return best;
}
function oldOfferedWalkObject(L: EdgeLedger, soul: EdgeSoul, input: string) {
  const q = normalizedPlaceName(input), caps = offersOfVerb(L, soul, 'walk').filter(c => c.target?.kind === 'object'), places = oldKnownBootPlaces(L, soul.soulId);
  const exact = caps.filter(c => normalizedPlaceName(c.label) === q), objects = exact.length ? exact : caps.filter(c => q === 'the ' + normalizedPlaceName(c.label));
  if (!objects.length) return null;
  const namePlaces = places.filter(p => normalizedPlaceName(p.name) === q), aliasPlaces = places.filter(p => p.aliases.some(a => normalizedPlaceName(a) === q));
  if (!exact.length && namePlaces.length) return null;
  const collision = exact.length ? namePlaces : aliasPlaces;
  if (objects.length + collision.length > 1) return {ok: false as const, code: 'place.ambiguous', reason: 'Several current destinations have that name or alias; use an exact offered capability ID.', did_you_mean: [...objects.map(c => ({id: c.id, label: c.label})), ...collision.map(p => ({id: 'walk:' + p.id, label: p.name}))]};
  const cap = objects[0]; if (!cap.available) return {ok: false as const, code: cap.blocked?.code ?? 'physical.unavailable', reason: cap.blocked?.reason ?? 'The current native destination capability is unavailable.', did_you_mean: []};
  return {ok: true as const, cap, matchedBy: exact.length ? 'name' as const : 'alias' as const};
}
function oldExplicitPlaceCapability(L: EdgeLedger, soul: EdgeSoul, asked: string, currentCaps?: EdgeCapability[]) {
  const i = asked.indexOf(':'); if (i <= 0) return null; const verb = asked.slice(0, i), target = asked.slice(i + 1);
  if (target === 'here') return null;
  if (!['walk', 'stroll', 'hang-out', 'gather', 'swim', 'read', 'lie', 'nap', 'sit-ground'].includes(verb)) return null;
  let menu: EdgeCapability[] | null = currentCaps ?? null; const caps = () => menu ??= L.coreA.binds(soul).caps;
  if (currentCaps ? currentCaps.some(c => c.id === asked) : typeof L.bindOne === 'function' ? L.bindOne(soul, asked) : caps().some(c => c.id === asked)) return null;
  if (verb === 'walk' && target.includes('/') && L.onDemandId?.(soul, asked)) return null;
  if (verb === 'walk') {const object = oldOfferedWalkObject(L, soul, target); if (object) return object.ok ? null : object;}
  const q = normalizedPlaceName(target), named = oldKnownBootPlaces(L, soul.soulId).some(p => p.id === target || normalizedPlaceName(p.name) === q || p.aliases.some(a => normalizedPlaceName(a) === q));
  if (!named) {const strict = oldStrictCheck(L, soul, asked, caps()); if (strict) return L.onDemandId?.(soul, asked) ? null : {ok: false as const, ...strict};}
  if (!named && verb !== 'walk' && verb !== 'stroll' && verb !== 'gather' && verb !== 'hang-out') return null;
  const r = oldResolvePlaceForVerb(L, soul, target, verb);
  return r.ok && r.chosen.capability === asked ? null : r;
}

// ---------------------------------------------------------------- the corpus and the comparison
/** Every case's answer by both paths, compared whole (ok, code, reason, did_you_mean, chosen, next), with ms by kind, and
 *  the refusal codes seen. A `cold` kind takes a tick before each case, so the new path meets no menu built this tick (its
 *  focused builds run, as in an act), and the old path then reads the same state. */
function compare(L: EdgeLedger, soul: EdgeSoul, corpus: Record<string, string[]>, what: string, tick: () => void, need = ['place.ambiguous', 'capability.unknown']) {
  const bad: string[] = [], ms: Record<string, {old: number; now: number; n: number}> = {}, codes = new Set<string>();
  for (const [kind, ids] of Object.entries(corpus)) for (const asked of ids) {
    if (kind.startsWith('cold')) tick();
    // the new path first: the caches it warms favour the old path, so the ms below never flatter the change
    const t0 = performance.now(), b = JSON.stringify(explicitPlaceCapability(L, soul, asked)), t1 = performance.now(), a = JSON.stringify(oldExplicitPlaceCapability(L, soul, asked)), t2 = performance.now();
    const m = ms[kind] ??= {old: 0, now: 0, n: 0}; m.now += t1 - t0; m.old += t2 - t1; m.n++;
    if (a !== b) bad.push(`${kind} ${asked}: was ${a.slice(0, 240)} | now ${b.slice(0, 240)}`);
    const code = (JSON.parse(a) as {code?: string} | null)?.code; codes.add(code ?? (a === 'null' ? 'null' : 'ok'));
  }
  assert.deepEqual(bad.slice(0, 6), [], `${what}: ${bad.length} answers differ`);
  // the refusals the change could drop are in the corpus and answered (the issue's footgun: place.ambiguous)
  for (const c of need) assert.ok(codes.has(c), `${what}: no answer was ${c}`);
  return Object.fromEntries(Object.entries(ms).map(([k, m]) => [k, `${m.n} cases, ms per case was ${(m.old / m.n).toFixed(2)} now ${(m.now / m.n).toFixed(2)}`]));
}

function corpusOf(L: EdgeLedger, soul: EdgeSoul): Record<string, string[]> {
  const menu = L.coreA.binds(soul).caps, walks = menu.filter(c => c.verb === 'walk'), offered = new Set(menu.map(c => c.id));
  const places = oldKnownBootPlaces(L, soul.soulId), objects = walks.filter(c => c.target?.kind === 'object');
  const norm = (s: string) => normalizedPlaceName(s), byName = new Map<string, number>();
  for (const p of places) for (const n of new Set([p.name, ...p.aliases].map(norm))) byName.set(n, (byName.get(n) ?? 0) + 1);
  const placeWords = new Set(places.flatMap(p => [p.name, ...p.aliases].map(norm)));
  const sharedNames = [...byName].filter(([, n]) => n > 1).map(([w]) => w);
  const objectPlaceWords = objects.map(c => norm(c.label)).filter(w => placeWords.has(w) || placeWords.has('the ' + w));
  const labels = new Map<string, number>(); for (const c of objects) labels.set(norm(c.label), (labels.get(norm(c.label)) ?? 0) + 1);
  const objectTwins = [...labels].filter(([, n]) => n > 1).map(([w]) => w);
  const verbs = ['walk', 'stroll', 'hang-out', 'gather', 'swim', 'read', 'lie', 'nap', 'sit-ground'];
  const notOffered = places.filter(p => !offered.has('walk:' + p.id));
  const every = <T,>(xs: T[], k: number) => xs.filter((_, i) => i % k === 0);
  return {
    offered: walks.map(c => c.id),
    'offered, other verbs': menu.filter(c => verbs.includes(c.verb) && c.verb !== 'walk').map(c => c.id).slice(0, 40),
    'not offered, known place by id': every(notOffered, 4).map(p => 'walk:' + p.id),
    'not offered, other verbs by id': every(notOffered, 41).flatMap(p => verbs.slice(1).map(v => `${v}:${p.id}`)),
    'place names and aliases': every(places, 17).flatMap(p => [p.name, ...p.aliases].map(n => 'walk:' + n)),
    'thing walk labels': every(objects, 3).flatMap(c => ['walk:' + c.label, 'walk:the ' + c.label]),
    unknown: ['walk:no-such-place', 'walk:eden-pond-north', 'walk:region-park.nowhere', 'walk:somewhere nice', 'stroll:xq-zz', 'gather:nowhere-at-all', 'read:no-such-book', 'swim:deep-sea-trench', 'hang-out:the moon', 'walk:e_00000000', 'walk:pond', 'walk:the park', 'walk:park'],
    ambiguous: [...new Set([...sharedNames, ...objectPlaceWords, ...objectTwins])].flatMap(w => ['walk:' + w, 'stroll:' + w, 'walk:the ' + w]),
    // ids the world knows that are no place and no offer (strictCheck answers them without the whole menu now)
    'known ids, not places': [...Object.keys(L.host.engine.world.entities).slice(0, 12).flatMap(id => [`walk:${id}`, `stroll:${id}`]), ...L.spots.spots.slice(0, 12).flatMap(x => [`swim:${x.id}`, `read:${x.id}`, `gather:${x.id}`])],
    'cold, not offered, known place by id': every(notOffered, 23).map(p => 'walk:' + p.id),
    'cold, known ids and unknown': ['walk:no-such-place', 'stroll:xq-zz', ...L.spots.spots.slice(0, 4).map(x => `read:${x.id}`)],
  };
}

/** #2528 step 3's boundary: an asked id that is a known place's id and also a thing walk's label (exactly, after an article,
 *  in other case), where that thing walk is offered now or is not (`earlier`: labels of an earlier listing, at other
 *  distances). Eden 2026 has no such id, so a place is added for each (no outline, no region: scenery) and removed after;
 *  without step 3's label test the act would refuse it place.unwalkable instead of acting on the thing's walk. */
function labelPlaceCases(L: EdgeLedger, soul: EdgeSoul, earlier: readonly string[] = []) {
  const now = L.coreA.binds(soul).caps.filter(c => c.verb === 'walk' && c.target?.kind === 'object').map(c => c.label), listed = new Set(now);
  const offered = now.filter((_, i) => i % 3 === 0).flatMap(l => [l, 'the ' + l, l.toUpperCase()]), gone = [...new Set(earlier)].filter(l => !listed.has(l)).slice(0, 40);
  const added = [...new Set([...offered, ...gone])].filter(id => !L.places.byId.has(id));
  added.forEach((id, i) => L.places.byId.set(id, {id, name: `Label place ${i}`, kind: 'area', parent: null, polygon: [], level: 0, enclosed: false, capacity: null, starting: false}));
  return {labels: now, undo: () => {for (const id of added) L.places.byId.delete(id);},
    corpus: {'place id is an offered thing walk\'s label': offered.map(l => 'walk:' + l), 'place id is a thing walk label not offered now': gone.map(l => 'walk:' + l)}};
}

test('#2528 A1: an act\'s place capability or refusal is the old path\'s, over Eden 2026\'s places, things and words', {timeout: 900_000, skip: NO_EDEN}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge as unknown as EdgeLedger, host = w.host, soul = w.soul as EdgeSoul;
  const run = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}} await setImmediate(); host.drainInputs();};
  await run(120);
  const corpus = corpusOf(L, soul);
  assert.ok(corpus.offered.length > 10 && corpus['not offered, known place by id'].length > 10, 'Eden 2026 offers walks and leaves far places out');
  assert.ok(corpus.ambiguous.length > 0, 'the corpus holds ambiguous words');
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(corpus).map(([k, v]) => [k, v.length]))));
  const tick = () => host.tickOnce();
  t.diagnostic('arrival ' + JSON.stringify(compare(L, soul, corpus, 'arrival', tick)));
  const labelled = (what: string, earlier?: string[]) => {
    const c = labelPlaceCases(L, soul, earlier);
    try {t.diagnostic(`${what}, label ids ` + JSON.stringify(compare(L, soul, c.corpus, `${what}, label ids`, tick, ['null'])));} finally {c.undo();}
    return c;
  };
  const first = labelled('arrival');
  assert.ok(first.corpus['place id is an offered thing walk\'s label'].length > 10, 'Eden 2026 offers thing walks');
  // and after a walk (another place, other offers)
  const go = L.coreA.binds(soul).caps.filter(c => c.verb === 'walk' && c.available && c.target?.kind === 'place')[5];
  if (go) {
    const r = await (await import('../../../test/native-owner-fixture.ts')).accept(host, L.act(soul, {capability: go.id})) as {accepted?: boolean}; assert.equal(r.accepted, true);
    for (let i = 0; i < 12 && L.openReceipts(soul.soulId).length; i++) await run(25);
    t.diagnostic(`after ${go.id} ` + JSON.stringify(compare(L, soul, corpusOf(L, soul), `after ${go.id}`, tick)));
    const after = labelled(`after ${go.id}`, first.labels);
    assert.ok(after.corpus['place id is a thing walk label not offered now'].length > 0, 'the walk changed which thing walks are offered');
  }
});

// ---------------------------------------------------------------- #2597: onDemandId and actMenu without the whole menu
/** An exact walk id asked without a menu: `onDemandId(soul, id)` and the act's offers (`actMenu`, its `pre` resolution) are
 *  what the whole menu answers (`onDemandId(soul, id, menu)`, `resolveOnDemand(id)` on it), over every walk listed, every
 *  known place and room by id the listing leaves out, and unknown ids. The act's other readings of an id (class words,
 *  together/1's phrasing) answer nothing for any of them, so the act reads the same offer either way. */
type ActMenu = {caps: EdgeCapability[]; plans: Map<string, unknown>; partial?: true; pre?: {v: {kind: string; cap?: EdgeCapability}; caps: EdgeCapability[]; plans: Map<string, unknown>}};
type Inside = {binds(s: EdgeSoul): {caps: EdgeCapability[]; plans: Map<string, unknown>}; actMenu(s: EdgeSoul, asked: string, params: unknown): ActMenu;
  resolveOnDemand(s: EdgeSoul, text: string, caps: EdgeCapability[], plans: Map<string, unknown>): {v: {kind: string; cap?: EdgeCapability}; caps: EdgeCapability[]; plans: Map<string, unknown>};
  onDemandId(s: EdgeSoul, asked: string, caps?: EdgeCapability[], plans?: Map<string, unknown>): boolean;
  together: {resolve(s: EdgeSoul, text: string, caps: EdgeCapability[], plans?: Map<string, unknown>): unknown};
  routeDeadAlternatives(s: EdgeSoul, capability: string, code: string, keptOnly?: boolean): unknown;
  capCache: Map<string, unknown>; wordsCache: Map<string, unknown>; lastMenu: Map<string, unknown>};
function walkIdCorpus(L: EdgeLedger, soul: EdgeSoul, refs: string[]): Record<string, string[]> {
  const menu = L.coreA.binds(soul).caps, offered = new Set(menu.map(c => c.id)), every = <T,>(xs: T[], k: number) => xs.filter((_, i) => i % k === 0);
  const places = [...L.places.byId.keys()].map(id => 'walk:' + id).filter(id => !offered.has(id));
  return {
    offered: every(menu.filter(c => c.verb === 'walk').map(c => c.id), 3),
    'not offered, place by id': every(places, 5),
    'not offered, room or thing by ref': every(refs.map(r => 'walk:' + r).filter(id => !offered.has(id)), 9),
    // (a Soul that has built no menu yet: its act keeps one, as before, for a failed wait's alternatives)
    'no kept menu, not offered, by id or ref': [...every(places, 37), ...every(refs.map(r => 'walk:' + r).filter(id => !offered.has(id)), 41)],
    unknown: ['walk:no-such-place', 'walk:region-park.nowhere', 'walk:no-such/room', 'walk:e_00000000'],
  };
}
function compareWalkIds(L: EdgeLedger, soul: EdgeSoul, corpus: Record<string, string[]>, what: string, tick: () => void) {
  const I = L as unknown as Inside, bad: string[] = [], seen = {fast: 0, onDemand: 0, n: 0, wholeMenus: 0, noMenu: 0};
  const sum = (v: {kind: string; cap?: EdgeCapability}, plans: Map<string, unknown>) => JSON.stringify([v.kind, v.cap ?? null, v.cap ? plans.get(v.cap.id) ?? null : null]);
  for (const [kind, ids] of Object.entries(corpus)) for (const asked of ids) {
    tick(); seen.n++;   // a tick each: no menu built this tick, as in an act
    const forget = () => {if (kind.startsWith('no kept menu')) {I.capCache.delete(soul.soulId); I.wordsCache.delete(soul.soulId); I.lastMenu.delete(soul.soulId);}};
    // a walk to this id that waits and then fails route-dead takes its alternatives from the menu the act left kept (failWait):
    // after the act's reads they are the old path's (forget: from a Soul with no kept menu, each path from the same start)
    forget(); I.onDemandId(soul, asked); I.actMenu(soul, asked, undefined); const altNow = JSON.stringify(I.routeDeadAlternatives(soul, asked, 'route.unreachable', true) ?? null);
    forget(); {const b0 = I.binds(soul); I.onDemandId(soul, asked, b0.caps, b0.plans); I.resolveOnDemand(soul, asked, [...b0.caps], new Map(b0.plans));} const altWas = JSON.stringify(I.routeDeadAlternatives(soul, asked, 'route.unreachable', true) ?? null);
    if (altNow !== altWas) bad.push(`${kind} ${asked}: failed-walk alternatives were ${altWas.slice(0, 200)} | now ${altNow.slice(0, 200)}`);
    if (kind.startsWith('no kept menu')) {seen.noMenu++; continue;}
    const reads = () => menuStats.cap.hit + menuStats.cap.hitKept + menuStats.cap.miss, r0 = reads(), nowOd = I.onDemandId(soul, asked), m = I.actMenu(soul, asked, undefined), whole = reads() - r0;
    const b = I.binds(soul), wasOd = I.onDemandId(soul, asked, b.caps, b.plans);
    if (nowOd !== wasOd) bad.push(`${kind} ${asked}: onDemandId was ${wasOd} now ${nowOd}`);
    if (wasOd) seen.onDemand++;
    // the point of #2597: an id the whole menu offers on demand as itself reads no whole menu here, kept or built (before: one or two)
    const ref = I.resolveOnDemand(soul, asked, [...b.caps], new Map(b.plans)).v;
    if (wasOd && ref.kind === 'exact' && ref.cap?.id === asked && whole) {seen.wholeMenus += whole; bad.push(`${kind} ${asked}: read the whole menu ${whole} time(s)`);}
    if (m.pre) {
      seen.fast++;
      const was = I.resolveOnDemand(soul, asked, [...b.caps], new Map(b.plans));
      if (sum(was.v, was.plans) !== sum(m.pre.v, m.pre.plans)) bad.push(`${kind} ${asked}: act offer was ${sum(was.v, was.plans).slice(0, 200)} | now ${sum(m.pre.v, m.pre.plans).slice(0, 200)}`);
      if (I.together.resolve(soul, asked, [...b.caps], new Map()) !== null) bad.push(`${kind} ${asked}: together/1 reads the id`);
    }
  }
  assert.deepEqual(bad.slice(0, 6), [], `${what}: ${bad.length} answers differ`);
  return seen;
}

test('#2597 A2: an exact walk id the listing leaves out is answered without the whole menu, as the whole menu answers it', {timeout: 900_000, skip: NO_EDEN}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge as unknown as EdgeLedger, host = w.host, soul = w.soul as EdgeSoul;
  const run = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}} await setImmediate(); host.drainInputs();};
  await run(120);
  const refs = (w.bridge as unknown as {nav: {things(): {ref: string; kind: string}[]}}).nav.things().filter(x => x.kind === 'room' || x.kind === 'building').map(x => x.ref);
  const tick = () => host.tickOnce();
  const first = compareWalkIds(L, soul, walkIdCorpus(L, soul, refs), 'arrival', tick);
  t.diagnostic('arrival ' + JSON.stringify(first));
  assert.ok(first.fast > 10 && first.onDemand > 10, 'far places and rooms are offered on demand, and the act reads them without the menu');
  const go = L.coreA.binds(soul).caps.filter(c => c.verb === 'walk' && c.available && c.target?.kind === 'place')[5];
  if (go) {
    const r = await (await import('../../../test/native-owner-fixture.ts')).accept(host, L.act(soul, {capability: go.id})) as {accepted?: boolean}; assert.equal(r.accepted, true);
    for (let i = 0; i < 12 && L.openReceipts(soul.soulId).length; i++) await run(25);
    t.diagnostic(`after ${go.id} ` + JSON.stringify(compareWalkIds(L, soul, walkIdCorpus(L, soul, refs), `after ${go.id}`, tick)));
  }
});

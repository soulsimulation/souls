// #2528 A1: an act's place capability (explicitPlaceCapability) builds the Soul's known places once, the whole menu only
// when a refusal needs its "did you mean" list, and no walk offer it does not read. The oracle: over a corpus from Eden
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
/** Every case's answer by both paths, compared whole (ok, code, reason, did_you_mean, chosen, next), with ms by kind. */
function compare(L: EdgeLedger, soul: EdgeSoul, corpus: Record<string, string[]>, what: string) {
  const bad: string[] = [], ms: Record<string, {old: number; now: number; n: number}> = {};
  for (const [kind, ids] of Object.entries(corpus)) for (const asked of ids) {
    // the new path first: the caches it warms favour the old path, so the ms below never flatter the change
    const t0 = performance.now(), b = JSON.stringify(explicitPlaceCapability(L, soul, asked)), t1 = performance.now(), a = JSON.stringify(oldExplicitPlaceCapability(L, soul, asked)), t2 = performance.now();
    const m = ms[kind] ??= {old: 0, now: 0, n: 0}; m.now += t1 - t0; m.old += t2 - t1; m.n++;
    if (a !== b) bad.push(`${kind} ${asked}: was ${a.slice(0, 240)} | now ${b.slice(0, 240)}`);
  }
  assert.deepEqual(bad.slice(0, 6), [], `${what}: ${bad.length} answers differ`);
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
  };
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
  t.diagnostic('arrival ' + JSON.stringify(compare(L, soul, corpus, 'arrival')));
  // and after a walk (another place, other offers)
  const go = L.coreA.binds(soul).caps.filter(c => c.verb === 'walk' && c.available && c.target?.kind === 'place')[5];
  if (go) {
    const r = await (await import('../../../test/native-owner-fixture.ts')).accept(host, L.act(soul, {capability: go.id})) as {accepted?: boolean}; assert.equal(r.accepted, true);
    for (let i = 0; i < 12 && L.openReceipts(soul.soulId).length; i++) await run(25);
    t.diagnostic(`after ${go.id} ` + JSON.stringify(compare(L, soul, corpusOf(L, soul), `after ${go.id}`)));
  }
});

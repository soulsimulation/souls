// #824: a refusal for "nothing matches" names what this Soul can do here and now instead (`alternatives`): at most 3
// available offers, the walk to a place its own words name first, never a repeat of did_you_mean; other refusals and
// accepted acts carry no such field.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {menuStats} from './edge/ledger/menu-stats.ts';

test('#824: refusals name bounded, available alternatives; other answers carry none', {timeout: 300000}, async t => {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  await invite(f, 'alice');
  const a = await accept(f.host, f.souls.create('dev:alice', {name: 'Avery', description: 'Refusal fixture'}));
  const edge = new EdgeLedger(f.host, f.db), m = f.host.minds.get(a.id)!;
  const soul = {soulId: a.id, entityId: m.entityId, name: m.name, owner: 'dev:alice'};
  const caps = edge.capabilitiesPage(soul, {all: true}).capabilities as {id: string; available: boolean}[];
  const available = new Set(caps.filter(c => c.available).map(c => c.id));
  const check = (out: any, what: string) => {
    assert.equal(out.accepted, false, what);
    assert.ok(Array.isArray(out.alternatives) && out.alternatives.length >= 1 && out.alternatives.length <= 3, `${what}: 1-3 alternatives ${JSON.stringify(out.alternatives)}`);
    for (const x of out.alternatives) {assert.ok(available.has(x.id), `${what}: ${x.id} is available now`); assert.equal(typeof x.label, 'string'); assert.deepEqual(Object.keys(x).filter(k => k !== 'partial').sort(), ['id', 'label', 'why']);}
    assert.equal(new Set(out.alternatives.map((x: any) => x.id)).size, out.alternatives.length, 'no repeats');
    for (const d of out.did_you_mean ?? []) assert.ok(!out.alternatives.some((x: any) => x.id === d.id), `${what}: ${d.id} is already in did_you_mean`);
  };
  // A1/A2: "fly up to the field" (S2 recovery case): nothing matches, and the walk its own words name comes first
  const fly = await edge.act(soul, {capability: 'fly up to the field'}) as any;
  assert.equal(fly.code, 'ride.unavailable'); assert.deepEqual(fly.did_you_mean, []); check(fly, 'fly');
  assert.equal(fly.alternatives[0].id, 'walk:field');
  // the named place's walk comes from the walk resolver ("to the field" -> walk:field), the same as `walk to the field`
  const flyTo = await edge.act(soul, {capability: 'fly to the green field'}) as any; check(flyTo, 'fly to'); assert.equal(flyTo.alternatives[0].id, 'walk:field');
  // CTRL-3 (#1095): an unknown verb with no place named has no same-intent alternative: other acts are not offered
  const unknown = await edge.act(soul, {capability: 'teleport somewhere nice'}) as any;
  assert.equal(unknown.code, 'capability.unknown'); assert.equal(unknown.alternatives, undefined, JSON.stringify(unknown.alternatives));
  // walking is only part of flying there
  assert.equal(fly.alternatives[0].partial, true); assert.match(fly.alternatives[0].why, /field/);
  // the same verb on something else here, and never another verb
  const dance = await edge.act(soul, {capability: 'dance with Zed'}) as any;
  for (const x of dance.alternatives ?? []) assert.equal(x.id.split(':')[0], 'dance', JSON.stringify(dance.alternatives));
  // a sit's alternatives are seats: never a walk or a stroll
  const seat = await edge.act(soul, {capability: 'sit:no-such-seat-here'}) as any;
  for (const x of seat.alternatives ?? []) {assert.equal(x.id.split(':')[0], 'sit', JSON.stringify(seat.alternatives)); assert.equal(typeof x.why, 'string');}
  assert.ok((seat.alternatives ?? []).length <= 3);
  // A1 (review): an unknown place id (the explicit place path) and an unknown Soul name (together/1) are covered too
  for (const asked of ['walk:atlantis', 'gather:no-such-place', 'hug Nobody', 'dance with Zed']) {
    const out = await edge.act(soul, {capability: asked}) as any; assert.equal(out.code, 'capability.unknown', `${asked}: ${JSON.stringify(out)}`);
    const verb = asked.split(/[: ]/)[0]; for (const x of out.alternatives ?? []) assert.equal(x.id.split(':')[0], verb, `${asked}: ${JSON.stringify(out.alternatives)}`);
  }
  // A3 (review): a description-only word never names the place ("teleport somewhere nice" names no walk)
  // A3: a refusal that is not "nothing matches" and an accepted act carry no alternatives
  const params = await accept(f.host, edge.act(soul, {capability: 'walk:field', params: {via: 'nowhere-at-all'}})) as any;
  assert.equal(params.accepted, false, JSON.stringify(params)); assert.equal(params.alternatives, undefined, JSON.stringify(params));
  const ok = await accept(f.host, edge.act(soul, {capability: 'wave'})) as any;
  assert.equal(ok.accepted, true, JSON.stringify(ok)); assert.equal(ok.alternatives, undefined);
  // A6: the field's size is bounded (3 entries, labels as offered)
  for (const out of [fly]) assert.ok(JSON.stringify({alternatives: out.alternatives}).length <= 600, 'bounded bytes');
});

// Review of 6d48ceb1: the motivating case. "The pond hall" names a region with no walk of its own; `walk the pond hall`
// resolves to its building's walk (walk:lab-pond-hall), and so must the refusal's first alternative (S3 demo, #831).
test('#824: a named region whose walk is its building\'s gives that walk first (hello-hamlet pond hall)', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const fly = await w.edge.act(w.soul, {capability: 'fly up to the pond hall'}) as any;
  assert.equal(fly.accepted, false, JSON.stringify(fly));
  assert.equal(fly.alternatives?.[0]?.id, 'walk:lab-pond-hall', JSON.stringify(fly.alternatives));
  const avail = new Set((w.edge.capabilitiesPage(w.soul, {all: true}).capabilities as {id: string; available: boolean}[]).filter(c => c.available).map(c => c.id));
  for (const x of fly.alternatives) assert.ok(avail.has(x.id), `${x.id} is available now`);
});

// Delta review of f269d320, non-blocking note 1: the stale words-menu walk, as a permanent test. The refusal's own menu
// has no walks, so the named walk comes from the kept words menu (approximate availability). If an exact rebuild
// (bindOne) no longer offers it, it must not be named: at 6d48ceb1 it still was.
test('#824: a named walk from the kept words menu is named only if it is still offered now', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const edge = w.edge as any, noWalks = (w.edge.capabilitiesPage(w.soul, {all: true}).capabilities as {verb: string}[]).filter(c => c.verb !== 'walk');
  const refusal = () => ({code: 'ride.unavailable', reason: 'no ride here', did_you_mean: []});
  // control: with the exact rebuild intact, the walk the words name comes first even though the menu has no walks
  const live = edge.withAlternatives(w.soul, 'fly up to the pond hall', refusal(), noWalks);
  assert.equal(live.alternatives?.[0]?.id, 'walk:lab-pond-hall', JSON.stringify(live.alternatives));
  // the walk is gone now: the exact rebuild returns nothing for it
  const bindOne = edge.bindOne.bind(edge); edge.bindOne = (soul: unknown, id: string) => id === 'walk:lab-pond-hall' ? undefined : bindOne(soul, id);
  const stale = edge.withAlternatives(w.soul, 'fly up to the pond hall', refusal(), noWalks);
  assert.ok(!(stale.alternatives ?? []).some((x: {id: string}) => x.id === 'walk:lab-pond-hall'), `stale walk named: ${JSON.stringify(stale.alternatives)}`);
  for (const x of stale.alternatives ?? []) assert.ok(bindOne(w.soul, x.id)?.cap.available, `${x.id} is available now`);
});

// #850, folded into #1095: a place no walk reaches names what this Soul can do instead, never the blocked walk itself. The
// hello-hamlet reading room's description names the cottage bench, so that comes first (A5); a house a god placed with its
// front door closed says nothing, so its room offers what is nearest that room, not nearest the Soul (#850 A2).
test('#850: a place no walk reaches names available alternatives', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const {ref: _r, hash: _h, by: _b, born: _bo, ...definition} = (w.god.model as any).resolvedDef('core/cottage@1');
  const placed = (w.god as any).act({ops: [
    {op: 'define', def: {...definition, name: 'closed-cottage-control', state: {...definition.state, doors: {type: 'json', default: {}}}}},
    {op: 'place', def: 'closed-cottage-control@1', name: 'closed-house', p: [20, -30], state: {doors: {'front-door': 'closed'}}}]});
  assert.equal(placed.accepted, true, JSON.stringify(placed)); await w.settle(6);
  const avail = new Set((w.edge.capabilitiesPage(w.soul, {all: true}).capabilities as {id: string; available: boolean}[]).filter(c => c.available).map(c => c.id));
  for (const [words, blocked] of [['go into the reading room', 'walk:lab-reading-room'], ['walk:lab-reading-room', 'walk:lab-reading-room'], ['walk:closed-house/bedroom', 'walk:closed-house/bedroom']]) {
    const r = await accept(w.host, w.edge.act(w.soul, {capability: words})) as any;
    assert.equal(r.code, 'route.unreachable', `${words}: ${JSON.stringify(r)}`);
    assert.ok(r.alternatives?.length >= 1 && r.alternatives.length <= 3, `${words}: 1-3 alternatives ${JSON.stringify(r.alternatives)}`);
    for (const x of r.alternatives) {assert.ok(avail.has(x.id), `${words}: ${x.id} is available now`); assert.notEqual(x.id, blocked); assert.ok(x.why, 'each says why'); assert.equal(x.partial, true, 'none is the place asked for');}
  }
  const room = await accept(w.host, w.edge.act(w.soul, {capability: 'walk:lab-reading-room'})) as any;
  assert.equal(room.alternatives[0].id, 'walk:cottage/bench', `the authored hint comes first: ${JSON.stringify(room.alternatives)}`);
  assert.ok(room.alternatives.some((x: any) => x.id.startsWith('sit:')), `and the sit it is for: ${JSON.stringify(room.alternatives)}`);
  const house = await accept(w.host, w.edge.act(w.soul, {capability: 'walk:closed-house/bedroom'})) as any;
  assert.equal(house.alternatives[0].id, 'walk:closed-house', JSON.stringify(house.alternatives));
  // a part of the closed room says nothing itself: its room's hint holds for it too, and a fallback's why is one clause
  const part = await accept(w.host, w.edge.act(w.soul, {capability: 'walk:lab-reading-room/hall'})) as any;
  assert.equal(part.alternatives[0].id, 'walk:cottage/bench', `the room's hint: ${JSON.stringify(part.alternatives)}`);
  for (const x of [...part.alternatives, ...house.alternatives]) assert.doesNotMatch(x.why, /,|\(/, `one clause: ${x.why}`);
});

// steward on #1108: A1 says never a different destination; the ground is not "another free seat"
for (const template of ['hello-hamlet', 'mars-two']) test(`#1095: on ${template} a walk naming no place offers no other destination, and sit:here comes last and says what it is`, {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL(`../../../worlds/templates/${template}.json`, import.meta.url)); t.after(w.close);
  for (const id of ['walk:oak-grove', 'walk:nowhere-at-all']) {
    const r = await accept(w.host, w.edge.act(w.soul, {capability: id})) as any;
    assert.equal(r.accepted, false, id);
    assert.equal(r.alternatives, undefined, `${id}: ${JSON.stringify(r.alternatives)}`);
  }
  const sit = await accept(w.host, w.edge.act(w.soul, {capability: 'sit:ghost-bench'})) as any;
  assert.equal(sit.accepted, false);
  const alts: any[] = sit.alternatives ?? [], ground = alts.findIndex(x => x.id === 'sit:here');
  assert.ok(alts.length, JSON.stringify(sit)); if (template === 'hello-hamlet') assert.ok(ground >= 0, 'no seat near: the ground, marked'); t.diagnostic(JSON.stringify(alts.map(x => [x.id, x.why, x.partial ?? false])));
  for (const [i, x] of alts.entries()) {
    assert.match(x.id, /^sit:/, JSON.stringify(alts));
    if (i === ground) {assert.equal(x.partial, true); assert.match(x.why, /ground/); assert.equal(i, alts.length - 1, 'after the real seats');}
    else {assert.equal(x.partial, undefined, x.id); assert.match(x.why, /seat/);}
  }
});

// ROUTE_DEAD's other codes take the same path; other blocked offers still carry no alternatives (#850 A3)
test('#850: every route-dead code names alternatives; a blocked offer of another kind names none', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const edge = w.edge as any, real = edge.withAlternatives.bind(edge), seen: string[] = [];
  edge.withAlternatives = (...a: any[]) => {seen.push(a[2].code); return real(...a);};
  const bound = edge.resolveOnDemand.bind(edge);
  for (const [code, named] of [['route.goal-blocked', true], ['route.link-unusable', true], ['route.unknown-level', true], ['seat.none-free', false], ['soul.busy', false]] as const) {
    edge.resolveOnDemand = (soul: unknown, text: string, caps: any[], plans: Map<string, unknown>) => {
      const r = bound(soul, text, caps, plans), cap = r.v?.cap;
      if (cap) {r.v = {...r.v, cap: {...cap, available: false, blocked: {code, reason: 'test'}}}; r.plans = new Map(r.plans); r.plans.delete(cap.id);}
      return r;
    };
    seen.length = 0;
    const r = await accept(w.host, edge.act(w.soul, {capability: 'walk:lab-pond-hall'})) as any;
    edge.resolveOnDemand = bound;
    assert.equal(r.code, code, JSON.stringify(r).slice(0, 200));
    assert.equal(seen.includes(code), named, `${code}: ${JSON.stringify(seen)}`);
    if (!named) assert.equal(r.alternatives, undefined, code);
  }
});


// #1468 (#850 follow-up): an offer that was available when the act came, whose walk the planner then refuses route-dead (a
// stand point it finds cut off, nav still cold, the world changed since the listing), names alternatives as a blocked offer
// does at listing time, never the refused act itself; another planner refusal names none (#850 A3)
test('#1468: an available offer the planner refuses route-dead names alternatives; another refusal names none', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const caps = w.edge.capabilitiesPage(w.soul, {all: true}).capabilities as {id: string; verb: string; available: boolean}[];
  const avail = new Set(caps.filter(c => c.available).map(c => c.id)), sits = caps.filter(c => c.available && c.verb === 'sit' && !c.id.endsWith(':here'));
  assert.ok(sits.length >= 2, `two free seats to choose between: ${sits.map(c => c.id)}`);
  const engine = w.host.engine as any, real = engine.canPerform.bind(engine);
  assert.ok(engine.navWarmV1(Infinity), 'warm: a cold refused walk waits for navigation instead (#884)');
  for (const [code, named] of [['route.unreachable', true], ['route.goal-blocked', true], ['seat.none-free', false]] as const) {
    // the planner seam, for this act's seat only: every other check is real
    engine.canPerform = (p: {actor: string; steps: {verb: string}[]}) => p.actor === w.soul.entityId && p.steps.some(s => /sit/.test(s.verb)) ? {code, message: `stubbed ${code}`} : real(p);
    let r: any; try {r = await accept(w.host, w.edge.act(w.soul, {capability: sits[0]!.id}));} finally {engine.canPerform = real;}
    assert.equal(r.accepted, false, `${code}: ${JSON.stringify(r)}`); assert.equal(r.code, code);
    if (!named) {assert.equal(r.alternatives, undefined, `${code}: ${JSON.stringify(r.alternatives)}`); continue;}
    assert.ok(r.alternatives?.length >= 1 && r.alternatives.length <= 3, `${code}: 1-3 alternatives ${JSON.stringify(r)}`);
    for (const x of r.alternatives) {assert.ok(avail.has(x.id), `${code}: ${x.id} is available now`); assert.notEqual(x.id, sits[0]!.id, 'never the refused act'); assert.ok(x.why, 'each says why');}
    t.diagnostic(`${code}: ${JSON.stringify(r.alternatives.map((x: any) => x.id))}`);
  }
  // a walk refused so (clip review at 05f450946: "…-roof-planter-1" named eden-house-1, "walks to 1"): an id's own words
  // name no other place; what is offered instead is near the refused place, and only partly serves
  const walks = caps.filter(c => c.available && c.verb === 'walk' && /\d/.test(c.id)), walk = walks[0] ?? caps.find(c => c.available && c.verb === 'walk')!;
  engine.canPerform = (p: {actor: string; steps: {verb: string}[]}) => p.actor === w.soul.entityId && p.steps.some(s => s.verb === 'walk_to') ? {code: 'route.unreachable', message: 'stubbed'} : real(p);
  let r: any; try {r = await accept(w.host, w.edge.act(w.soul, {capability: walk.id}));} finally {engine.canPerform = real;}
  assert.equal(r.code, 'route.unreachable', JSON.stringify(r));
  assert.ok(r.alternatives?.length >= 1, `${walk.id}: ${JSON.stringify(r)}`);
  for (const x of r.alternatives) {assert.notEqual(x.id, walk.id); assert.ok(avail.has(x.id)); assert.equal(x.partial, true, `${x.id} only partly serves`); assert.doesNotMatch(x.why, /^walks to /, `no place named by the id's own words: ${x.why}`);}
  t.diagnostic(`${walk.id}: ${JSON.stringify(r.alternatives.map((x: any) => [x.id, x.why]))}`);
});

// #1503 (#1502 A2): an act-time route-dead refusal names its alternatives from the Soul's kept menu, or from a focused build
// when it has none, never from a whole menu built inside the request (76-750 ms on Eden 2026, the clock blocked meanwhile)
test('#1503: an act-time route-dead refusal builds no whole menu, with a kept menu or with none', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  const L = w.edge as unknown as {capCache: Map<string, unknown>; wordsCache: Map<string, unknown>; focusCache: Map<string, unknown>; lastMenu: Map<string, unknown>};
  const caps = w.edge.capabilitiesPage(w.soul, {all: true}).capabilities as {id: string; verb: string; available: boolean}[];
  const avail = new Set(caps.filter(c => c.available).map(c => c.id)), walks = caps.filter(c => c.available && c.verb === 'walk');
  assert.ok(walks.length >= 4, 'walks to choose between');
  const engine = w.host.engine as any, real = engine.canPerform.bind(engine);
  assert.ok(engine.navWarmV1(Infinity), 'warm: a cold refused walk waits for navigation instead (#884)');
  for (const [menu, walk] of [['kept', walks[1]!], ['none', walks[2]!]] as const) {
    if (menu === 'none') {L.capCache.clear(); L.wordsCache.clear(); L.focusCache.clear(); L.lastMenu.clear();}
    const whole0 = menuStats.cap.miss, words0 = menuStats.words.built;
    engine.canPerform = (p: {actor: string; steps: {verb: string}[]}) => p.actor === w.soul.entityId && p.steps.some(s => s.verb === 'walk_to') ? {code: 'route.unreachable', message: 'stubbed'} : real(p);
    let r: any; try {r = await accept(w.host, w.edge.act(w.soul, {capability: walk.id}));} finally {engine.canPerform = real;}
    assert.equal(r.code, 'route.unreachable', JSON.stringify(r));
    assert.equal(menuStats.cap.miss - whole0, 0, `${menu}: no whole menu built in the request`);
    assert.equal(menuStats.words.built - words0, 0, `${menu}: no words menu built in the request`);
    assert.ok(r.alternatives?.length >= 1 && r.alternatives.length <= 3, `${menu}: 1-3 alternatives ${JSON.stringify(r)}`);
    for (const x of r.alternatives) {assert.ok(avail.has(x.id), `${menu}: ${x.id} is available now`); assert.notEqual(x.id, walk.id, 'never the refused act');}
    t.diagnostic(`${menu} menu, ${walk.id}: ${JSON.stringify(r.alternatives.map((x: any) => x.id))}`);
  }
});

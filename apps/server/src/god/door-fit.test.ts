// #2383 door-fit/1 on a copy of a template world: Hello Hamlet as it was before its buildings were door-fitted (the fitted
// revisions mapped back, their doors left out) boots, the boot rule fits it in one recorded edit and logs one rules event,
// the result equals the fitted template's own buildings and doors, nobody moves, and a second boot does nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOOR_FIT_FROM } from '@souls/world-compiler';
import { bootEden } from '../../test/eden-capabilities-timing.ts';
import { accept } from '../../test/native-owner-fixture.ts';
import { enableDoorFitV1, enableDoorFitV2 } from '../edge-runtime-rules.ts';
import { doorFit, doorFitted, DOOR_FIT_DOOR } from './door-fit.ts';

// #2434: door-fit/1's templates as #2383 left them (outside ground-floor doors only); worlds/templates now carry door-fit/2
const template = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/door-fit1/${name}.json`, import.meta.url), 'utf8'));
const current = (name: string) => JSON.parse(readFileSync(new URL(`../../../../worlds/templates/${name}.json`, import.meta.url), 'utf8'));
const fitted = template('hello-hamlet');
const back = new Map([...DOOR_FIT_FROM].map(([from, to]) => [to.ref, from]));
type PlaceOp = { op: string; def: string; name?: string; p?: number[]; r?: number; params?: Record<string, unknown>; state?: Record<string, unknown> };
const places = (tpl: { batches: { ops: PlaceOp[] }[] }) => tpl.batches.flatMap((b) => b.ops).filter((o) => o.op === 'place');

/** A template as it was before door-fit (the fitted revisions mapped back, their doors left out), booted. */
async function before(t: { after: (f: () => void) => void }, fitted: { batches: { ops: PlaceOp[] }[] }) {
  const before = structuredClone(fitted) as { batches: { ops: PlaceOp[] }[] };
  for (const b of before.batches) b.ops = b.ops.filter((o) => !(o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? ''))).map((o) => back.has(o.def) ? { ...o, def: back.get(o.def)! } : o);
  const file = join(mkdtempSync(join(tmpdir(), 'door-fit-')), 'before.json'); writeFileSync(file, JSON.stringify(before));
  const w = await bootEden(() => {}, pathToFileURL(file)); t.after(w.close);
  return { w, old: places(before).filter((o) => DOOR_FIT_FROM.has(o.def)) };
}

test('door-fit/1: a template world from before is fitted once, like the fitted template, and nobody moves', { timeout: 300000 }, async (t) => {
  const { w, old } = await before(t, fitted);
  assert.equal(old.length, 3, 'a cottage and two halls on their old revisions');
  const { god, host, soul } = w;
  const ents = () => host.engine.world.entities as Record<string, { pose: { p: number[] } }>;
  const pose0 = structuredClone(ents()[soul.entityId]!.pose);
  const ids0 = [...god.model.entities.values()].filter((e) => doorFitted(e.def)).map((e) => [e.id, god.model.subtree(e.id)] as const);
  const seq0 = god.model.editSeq;

  const fact = await accept<unknown>(host, enableDoorFitV1(host, god) as Promise<never>) as { payload: { doorFitV1: unknown; runtimePolicy: { doorFitV1: boolean } } };
  assert.deepEqual(fact.payload.doorFitV1, { buildings: 3, doors: 3, series: 0, held: 0 }, 'logged with what it fitted');
  assert.equal(fact.payload.runtimePolicy.doorFitV1, true);
  assert.equal(god.model.editSeq, seq0 + 1, 'one recorded edit');
  await w.settle(10);

  // the same ids and contents, on the fitted revisions; the doors the fitted template places, open (until #2434)
  for (const [id, sub] of ids0) { assert.equal(god.model.entities.get(id)!.def.replace('core-', 'core/'), DOOR_FIT_FROM.get(old.find((o) => o.name === god.model.entities.get(id)!.name)!.def)!.ref); assert.deepEqual(god.model.subtree(id), sub, 'contents kept'); }
  assert.equal([...god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 0, 'nothing left on an old revision');
  const doors = [...god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).map((e) => ({ name: e.name, p: [e.p![0], e.p![e.p!.length - 1]], r: e.r, sx: e.params?.sx, sy: e.params?.sy, open: e.state?.open }));
  const want = places(fitted).filter((o) => o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? '')).map((o) => ({ name: o.name, p: [o.p![0], o.p![o.p!.length - 1]], r: o.r, sx: o.params?.sx, sy: o.params?.sy, open: o.state?.open }));
  assert.equal(doors.length, 3);
  assert.deepEqual(new Set(doors.map((d) => JSON.stringify(d))), new Set(want.map((d) => JSON.stringify(d))), 'the live world and the template agree');
  assert.ok(doors.every((d) => d.open === true), 'placed open until the multi-door passage (#2434)');
  assert.deepEqual(ents()[soul.entityId]!.pose.p, pose0.p, 'nobody moved');
  assert.deepEqual(host.engine.runtime.violations, []);

  assert.equal(await enableDoorFitV1(host, god), undefined, 'once: a second boot queues nothing');
  assert.equal(god.model.editSeq, seq0 + 1, 'and edits nothing');
});

test('door-fit/1: every door is placed open (until #2434), a body in its doorway or not', () => {
  const cottage = places(fitted).find((o) => o.def === 'core/cottage@2')!;
  const fit = doorFit('core/cottage@1', cottage.params, cottage.p, cottage.r, cottage.name)!;
  const at = fit.doors[0]!.p as [number, number];
  const busy = doorFit('core/cottage@1', cottage.params, cottage.p, cottage.r, cottage.name, [[at[0] + 0.3, at[1]]])!;
  assert.ok(fit.doors.length > 0 && [...fit.doors, ...busy.doors].every((d) => d.state!.open === true), 'open');
  assert.equal(doorFit('core/hall@2', {}, [0, 0], 0, 'x'), null, 'core/hall@2 already has its doors');
});

// Review of #2397: a door a hand cannot work is held back as an open gap. Mars Camp's living room has a bench where the body
// steps while closing its door from inside (contact.step-blocked): door-fit/1 places its other doors and leaves that
// doorway bare, as the fitted template does.
test('door-fit/1: a door a hand cannot work is held back; the rest are placed, as in the template', { timeout: 300000 }, async (t) => {
  const camp = template('mars-camp');
  const { w } = await before(t, camp);
  const fact = await accept<unknown>(w.host, enableDoorFitV1(w.host, w.god) as Promise<never>) as { payload: { doorFitV1: { held: number; doors: number } } };
  assert.equal(fact.payload.doorFitV1.held, 1, 'one held back');
  const names = [...w.god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).map((e) => e.name).sort();
  const want = places(camp).filter((o) => o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? '')).map((o) => o.name).sort();
  assert.deepEqual(names, want, 'the doors the fitted template has');
  assert.ok(!names.includes('living-room-door-1'), 'the living room doorway stays an open gap');
  assert.equal(fact.payload.doorFitV1.doors, want.length);
});

// Review of #2397: no refusal is final. A building the world refuses (a code other than body.protected) keeps its old
// revision this boot, the rules event waits, and the next boot fits it.
test('door-fit/1: a refused building is tried again at the next boot', { timeout: 300000 }, async (t) => {
  const { w } = await before(t, fitted);
  const real = w.god.engineAct.bind(w.god);
  w.god.engineAct = (() => ({ accepted: false, failures: [{ op: 0, code: 'overlap.solid', detail: 'test: refused' }] })) as never;
  assert.equal(await enableDoorFitV1(w.host, w.god), undefined, 'refused: no event');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 3, 'kept on the old revisions');
  w.god.engineAct = real;
  const fact = await accept<unknown>(w.host, enableDoorFitV1(w.host, w.god) as Promise<never>) as { payload: { doorFitV1: { buildings: number } } };
  assert.equal(fact.payload.doorFitV1.buildings, 3, 'the next boot fits them');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 0);
});

// #2434 door-fit/2: a world as door-fit/1 left it (outside ground-floor doors only) gets a real door in every other
// doorway in one recorded edit and one logged event, the same doors the template now carries; a door both of whose
// swings a prop blocks moves the prop (Mars Camp's living-room bench, 0.25 m); a second boot does nothing.
for (const name of ['hello-hamlet', 'mars-camp']) {
  test(`door-fit/2: ${name} as door-fit/1 left it gets every doorway's door, like the template`, { timeout: 300000 }, async (t) => {
    const w = await bootEden(() => {}, new URL(`../../test/fixtures/door-fit1/${name}.json`, import.meta.url)); t.after(w.close);
    const { god, host, soul } = w;
    const ents = () => host.engine.world.entities as Record<string, { pose: { p: number[] } }>;
    const pose0 = structuredClone(ents()[soul.entityId]!.pose), seq0 = god.model.editSeq;
    const doorNames = () => [...god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).map((e) => e.name).sort();
    const before = doorNames();
    const fact = await accept<unknown>(host, enableDoorFitV2(host, god) as Promise<never>) as { payload: { doorFitV2: { buildings: number; doors: number; moved: number; held: number }; runtimePolicy: { doorFitV2: boolean } } };
    assert.equal(fact.payload.runtimePolicy.doorFitV2, true);
    assert.equal(fact.payload.doorFitV2.held, 0, 'no doorway left without a door');
    assert.equal(god.model.editSeq, seq0 + 1, 'one recorded edit');
    const want = places(current(name)).filter((o) => o.def === DOOR_FIT_DOOR).map((o) => o.name).sort();
    assert.deepEqual(doorNames(), want, 'the doors the template carries');
    assert.equal(fact.payload.doorFitV2.doors, want.length - before.length, 'door-fit/1\'s doors kept, the rest added');
    assert.ok([...god.model.entities.values()].filter((e) => /^core-\w[\w-]*@\d+$/.test(e.def) && e.in.parent === 'world').every((e) => !doorFitted(e.def)));
    if (name === 'mars-camp') {
      assert.equal(fact.payload.doorFitV2.moved, 1, 'the living-room bench moved clear');
      const bench = [...god.model.entities.values()].find((e) => e.name === 'living-bench')!, tpl = places(current(name)).find((o) => o.name === 'living-bench')!;
      assert.deepEqual(bench.p, tpl.p, 'where the template has it');
    }
    await w.settle(10);
    assert.deepEqual(ents()[soul.entityId]!.pose.p, pose0.p, 'nobody moved');
    assert.deepEqual(host.engine.runtime.violations, []);
    const seq1 = god.model.editSeq;   // (a resident's own acts may edit while the world ticks)
    assert.equal(await enableDoorFitV2(host, god), undefined, 'once: a second boot queues nothing');
    assert.equal(god.model.editSeq, seq1, 'and edits nothing');
  });
}

// #2383 door-fit/1 on a copy of a template world: Hello Hamlet as it was before its buildings were door-fitted (the fitted
// revisions mapped back, their doors left out) boots, the boot rule fits it, one recorded edit per building, and logs one rules event,
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
import { adoptBootRuntimePoliciesV1, doorFitBoot, doorFitV1, enableDoorFitV1 } from '../edge-runtime-rules.ts';
import { doorFit, doorFitted, DOOR_FIT_DOOR } from './door-fit.ts';

const template = (name: string) => JSON.parse(readFileSync(new URL(`../../../../worlds/templates/${name}.json`, import.meta.url), 'utf8'));
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
  assert.equal(god.model.editSeq, seq0 + 3, 'one recorded edit per building (review of #2438: in slices)');
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
  assert.equal(god.model.editSeq, seq0 + 3, 'and edits nothing');
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

// Coordinator, push of 15 Nov: live-world door migration is off until a fit can run in slices under 1 s. One building's
// engine edit took up to 15.9 s on Eden, so the boot rule runs only with DOOR_FIT_BOOT=1; templates keep their doors.
test('door-fit/1 at boot is opt-in: DOOR_FIT_BOOT=1, off by default', () => {
  assert.equal(doorFitBoot({}), false, 'off when unset');
  assert.equal(doorFitBoot({ DOOR_FIT_BOOT: '0' }), false);
  assert.equal(doorFitBoot({ DOOR_FIT_BOOT: '1' }), true);
});

test('door-fit/1 off: booting Eden from before the fit adopts nothing and adds no door', { timeout: 600000 }, async (t) => {
  const was = process.env.DOOR_FIT_BOOT; delete process.env.DOOR_FIT_BOOT; t.after(() => { if (was !== undefined) process.env.DOOR_FIT_BOOT = was; });
  const { w, old } = await before(t, template('eden-2026'));
  assert.ok(old.length > 0, 'buildings on their old revisions');
  const seq0 = w.god.model.editSeq, doors0 = [...w.god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).length;
  await accept<unknown>(w.host, adoptBootRuntimePoliciesV1(w.host, { edge: false, worldKey: 'eden', god: () => w.god }));
  assert.equal(doorFitV1(w.host), false, 'door-fit/1 not adopted');
  assert.equal(w.god.model.editSeq, seq0, 'no edit');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length, old.length, 'every building keeps its drawn doorways');
  assert.equal([...w.god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).length, doors0, 'no door added');
});

test('door-fit/1 on (DOOR_FIT_BOOT=1): the boot rules run the sliced fit', { timeout: 300000 }, async (t) => {
  const was = process.env.DOOR_FIT_BOOT; process.env.DOOR_FIT_BOOT = '1'; t.after(() => { if (was === undefined) delete process.env.DOOR_FIT_BOOT; else process.env.DOOR_FIT_BOOT = was; });
  const { w } = await before(t, fitted);
  const seq0 = w.god.model.editSeq;
  await accept<unknown>(w.host, adoptBootRuntimePoliciesV1(w.host, { edge: false, worldKey: 'eden', god: () => w.god }));
  assert.equal(doorFitV1(w.host), true, 'adopted');
  assert.equal(w.god.model.editSeq, seq0 + 3, 'one recorded edit per building');
  assert.equal([...w.god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 0);
});

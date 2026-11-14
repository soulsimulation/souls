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
import { enableDoorFitV1 } from '../edge-runtime-rules.ts';
import { doorFit, doorFitted, DOOR_FIT_DOOR } from './door-fit.ts';

const fitted = JSON.parse(readFileSync(new URL('../../../../worlds/templates/hello-hamlet.json', import.meta.url), 'utf8'));
const back = new Map([...DOOR_FIT_FROM].map(([from, to]) => [to.ref, from]));
type PlaceOp = { op: string; def: string; name?: string; p?: number[]; r?: number; params?: Record<string, unknown>; state?: Record<string, unknown> };
const places = (tpl: { batches: { ops: PlaceOp[] }[] }) => tpl.batches.flatMap((b) => b.ops).filter((o) => o.op === 'place');

test('door-fit/1: a template world from before is fitted once, like the fitted template, and nobody moves', { timeout: 300000 }, async (t) => {
  const before = structuredClone(fitted) as { batches: { ops: PlaceOp[] }[] };
  for (const b of before.batches) b.ops = b.ops.filter((o) => !(o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? ''))).map((o) => back.has(o.def) ? { ...o, def: back.get(o.def)! } : o);
  const old = places(before).filter((o) => DOOR_FIT_FROM.has(o.def));
  assert.equal(old.length, 3, 'a cottage and two halls on their old revisions');
  const file = join(mkdtempSync(join(tmpdir(), 'door-fit-')), 'hamlet-before.json'); writeFileSync(file, JSON.stringify(before));
  const w = await bootEden(() => {}, pathToFileURL(file)); t.after(w.close);
  const { god, host, soul } = w;
  const ents = () => host.engine.world.entities as Record<string, { pose: { p: number[] } }>;
  const pose0 = structuredClone(ents()[soul.entityId]!.pose);
  const ids0 = [...god.model.entities.values()].filter((e) => doorFitted(e.def)).map((e) => [e.id, god.model.subtree(e.id)] as const);
  const seq0 = god.model.editSeq;

  const fact = await accept<unknown>(host, enableDoorFitV1(host, god) as Promise<never>) as { payload: { doorFitV1: unknown; runtimePolicy: { doorFitV1: boolean } } };
  assert.deepEqual(fact.payload.doorFitV1, { buildings: 3, doors: 3, series: 0, kept: [] }, 'logged with what it fitted');
  assert.equal(fact.payload.runtimePolicy.doorFitV1, true);
  assert.equal(god.model.editSeq, seq0 + 1, 'one recorded edit');
  await w.settle(10);

  // the same ids and contents, on the fitted revisions; the doors the fitted template places, closed
  for (const [id, sub] of ids0) { assert.equal(god.model.entities.get(id)!.def.replace('core-', 'core/'), DOOR_FIT_FROM.get(old.find((o) => o.name === god.model.entities.get(id)!.name)!.def)!.ref); assert.deepEqual(god.model.subtree(id), sub, 'contents kept'); }
  assert.equal([...god.model.entities.values()].filter((e) => doorFitted(e.def)).length, 0, 'nothing left on an old revision');
  const doors = [...god.model.entities.values()].filter((e) => e.def.replace('core-', 'core/') === DOOR_FIT_DOOR).map((e) => ({ name: e.name, p: [e.p![0], e.p![e.p!.length - 1]], r: e.r, sx: e.params?.sx, sy: e.params?.sy, open: e.state?.open }));
  const want = places(fitted).filter((o) => o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? '')).map((o) => ({ name: o.name, p: [o.p![0], o.p![o.p!.length - 1]], r: o.r, sx: o.params?.sx, sy: o.params?.sy, open: o.state?.open }));
  assert.equal(doors.length, 3);
  assert.deepEqual(new Set(doors.map((d) => JSON.stringify(d))), new Set(want.map((d) => JSON.stringify(d))), 'the live world and the template agree');
  assert.ok(doors.every((d) => d.open === false), 'enclosed rooms: closed');
  assert.deepEqual(ents()[soul.entityId]!.pose.p, pose0.p, 'nobody moved');
  assert.deepEqual(host.engine.runtime.violations, []);

  assert.equal(await enableDoorFitV1(host, god), undefined, 'once: a second boot queues nothing');
  assert.equal(god.model.editSeq, seq0 + 1, 'and edits nothing');
});

test('door-fit/1: a door whose doorway a body stands in is placed open', () => {
  const cottage = places(fitted).find((o) => o.def === 'core/cottage@2')!;
  const fit = doorFit('core/cottage@1', cottage.params, cottage.p, cottage.r, cottage.name)!;
  const at = fit.doors[0]!.p as [number, number];
  const busy = doorFit('core/cottage@1', cottage.params, cottage.p, cottage.r, cottage.name, [[at[0] + 0.3, at[1]]])!;
  assert.equal(busy.doors[0]!.state!.open, true, 'occupied: open');
  assert.deepEqual(busy.doors.slice(1).map((d) => d.state!.open), fit.doors.slice(1).map(() => false), 'the rest closed');
  assert.equal(doorFit('core/hall@2', {}, [0, 0], 0, 'x'), null, 'core/hall@2 already has its doors');
});

// A5 (#2530) on the real Eden 2026 template (fake minds, in memory): an act's bind (`bindAct`, and the strict gate's
// `gateBind`) reads only. A spy on every SQL statement run and on host.enqueue sees no write and nothing enqueued, for
// offered ids, a far place's walk, unknown ids, words, a stop and a step-failing body; the spy does see the act's own writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {ledgerCatalog} from './edge/catalog/routes.ts';

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

test('Eden: bindAct and gateBind write nothing and enqueue nothing', {timeout: 600_000}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge as any, host = w.host as any, soul = w.soul;
  for (let i = 0; i < 120; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}}
  await setImmediate(); host.drainInputs();

  // the spy: every statement's run and every exec on this database, and every enqueue
  const writes: string[] = [], db = L.db.db, stmt = Object.getPrototypeOf(db.prepare('SELECT 1')), dbProto = Object.getPrototypeOf(db);
  const run = stmt.run, exec = dbProto.exec, enqueue = host.enqueue;
  stmt.run = function (this: {sourceSQL: string}, ...a: unknown[]) {if (WRITE.test(this.sourceSQL)) writes.push(this.sourceSQL.slice(0, 60)); return run.apply(this, a);};
  dbProto.exec = function (this: unknown, sql: string) {if (WRITE.test(sql)) writes.push(sql.slice(0, 60)); return exec.call(this, sql);};
  host.enqueue = (...a: unknown[]) => {writes.push(`enqueue ${String(a[0])}`); return enqueue.apply(host, a);};
  t.after(() => {stmt.run = run; dbProto.exec = exec; host.enqueue = enqueue;});
  const spied = <T>(f: () => T): {out: T; writes: string[]} => {writes.length = 0; const out = f(); return {out, writes: [...writes]};};

  const offered = (L.coreA.binds(soul).caps as {id: string; verb: string; available: boolean}[]).filter(c => c.available);
  const byVerb = new Map<string, string>(); for (const c of offered) if (!byVerb.has(c.verb)) byVerb.set(c.verb, c.id);
  const cat = ledgerCatalog(L).payload as any, far = cat.places.filter((p: any) => !p.level && p.parent && !p.fixed).slice(0, 2);
  const asks: Record<string, unknown>[] = [
    ...[...byVerb.values()].slice(0, 12).map(capability => ({capability})),
    ...far.map((p: {id: string}) => ({capability: `walk:${p.id}`})),
    {capability: 'walk:eden-no-such-place'}, {capability: 'sit:no-such-thing'}, {capability: 'eat:eat.e_no-such-spot'},
    {capability: 'walk to the library'}, {capability: 'sit down'}, {capability: 'stop:current'}, {capability: 'wave'},
  ];
  assert.ok(byVerb.size >= 5, `several offered verbs (${[...byVerb.keys()].join(', ')})`);

  await t.test('A3: bindAct and gateBind write nothing and enqueue nothing', () => {
    for (const input of asks) {
      L.invalidateBodies?.();
      const gate = spied(() => L.gateBind(soul, input)), bind = spied(() => L.bindAct(soul, input));
      assert.deepEqual(gate.writes, [], `gateBind ${String(input.capability)}`);
      assert.deepEqual(bind.writes, [], `bindAct ${String(input.capability)}`);
      const b = bind.out;
      assert.equal(typeof b.inputs.menu, 'string'); assert.equal(b.inputs.tick, host.engine.world.tick); assert.equal(typeof b.inputs.navEpoch, 'number');
    }
  });

  await t.test('A3: a step-failing body: the refusal is returned, not recorded', () => {
    const failing = host.stepFailingFor; host.stepFailingFor = () => true;
    try {const b = spied(() => L.bindAct(soul, {capability: byVerb.get('wave') ?? [...byVerb.values()][0]})); assert.deepEqual(b.writes, []); assert.ok(b.out.refusal?.code, 'refused');}
    finally {host.stepFailingFor = failing;}
  });

  await t.test('bindAct answers: an offered walk with its steps, an unknown place with its refusal', () => {
    const walk = byVerb.get('walk'); if (walk) {const b = L.bindAct(soul, {capability: walk}); assert.equal(b.capability, walk); assert.ok(b.steps?.length, 'steps');}
    const no = L.bindAct(soul, {capability: 'walk:eden-no-such-place'});
    assert.ok(no.refusal?.code, `refused (${JSON.stringify(no.next.kind)})`);
  });
  await t.test('A3: the spy sees a refusal recorded and an act enqueued (it can see writes)', async () => {
    assert.deepEqual(spied(() => L.recordRefusal(soul.soulId, 'act', 'x:y', 'test.code', 'test')).writes.length, 1);
    writes.length = 0; let done = false; const p = L.act(soul, {capability: byVerb.get('walk') ?? [...byVerb.values()][0]}).finally(() => {done = true;});
    for (let i = 0; i < 200 && !done; i++) {host.tickOnce(); await setImmediate(); host.drainInputs();}
    await p;
    assert.ok(writes.length > 0, 'an accepted act writes');
  });

});

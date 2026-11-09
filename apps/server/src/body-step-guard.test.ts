// #1332 body-step-guard/1 is one logged rules event: adopted once (a second call logs nothing), replayed by a boot from the
// log to the live hash, and absent from a world that never adopted it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, accept } from '../test/native-owner-fixture.ts';
import { adoptBootRuntimePoliciesV1 } from './edge-runtime-rules.ts';

// the event that adopted the guard: later runtime-policy events copy the whole policy, so they carry the flag too (#1369)
const adopting = (key: string) => (f: ReturnType<typeof fixture>) => f.db.events(f.host.worldId).filter((e, i, all) => e.kind === 'rules' && (e.payload as { runtimePolicy?: Record<string, unknown> }).runtimePolicy?.[key] === true
  && !all.slice(0, i).some((d) => d.kind === 'rules' && (d.payload as { runtimePolicy?: Record<string, unknown> }).runtimePolicy?.[key] === true));
const guardEvents = adopting('bodyStepGuardV1'), quarantineEvents = adopting('quarantineV1');

test('body-step-guard/1: one rules event, idempotent, and a boot from the log reaches the live hash with the rule on', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'body-step-guard-')), file = join(root, 'sim.db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(file);
  const before = f.host.engine.stateHash();
  assert.equal(guardEvents(f).length, 0, 'a world that never adopted it has no such event');
  await accept<unknown>(f.host, f.host.enableBodyStepGuardV1('world'));
  await accept<unknown>(f.host, f.host.enableBodyStepGuardV1('world'));
  assert.equal(guardEvents(f).length, 1, 'adopted once');
  assert.equal((f.host.extra.runtimePolicy as { bodyStepGuardV1?: boolean }).bodyStepGuardV1, true);
  assert.notEqual(f.host.engine.stateHash(), before, 'the rule is part of the state');
  const live = f.host.engine.stateHash(), tick = f.host.engine.world.tick;
  f.host.stop(); f.db.close();
  const g = fixture(file);
  t.after(() => { g.host.stop(); g.db.close(); });
  assert.equal(g.host.engine.world.tick, tick);
  assert.equal(g.host.engine.stateHash(), live, 'a boot from the log reaches the live hash');
  await accept<unknown>(g.host, g.host.enableBodyStepGuardV1('world'));
  assert.equal(guardEvents(g).length, 1, 'a booted world does not adopt it twice');
});

const policy = (f: ReturnType<typeof fixture>) => f.host.extra.runtimePolicy as Record<string, unknown> | undefined;
test('boot order: the courtesy event, the edge rules, body-step-guard/1 and hold-settle/1 are applied one after another, so none drops another and a reboot logs nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'body-step-guard-boot-')), file = join(root, 'sim.db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boot = async (f: ReturnType<typeof fixture>) => {
    // main.ts: the living world's courtesy event is queued first, then the chain
    const courtesy = (policy(f)?.quietSeatCourtesy ? Promise.resolve() : f.host.enqueue('rules', 'world', { runtimePolicy: { sleepBlockTicks: 1200, ...policy(f), quietSeatCourtesy: true }, why: 'test: as main.ts' })) as Promise<unknown>;
    await accept<unknown>(f.host, adoptBootRuntimePoliciesV1(f.host, { after: courtesy, edge: true, worldKey: 'eden' }));
  };
  const f = fixture(file); await boot(f);
  const p = policy(f)!;
  for (const k of ['quietSeatCourtesy', 'quietStallReleaseV1', 'bodyStepGuardV1', 'quarantineV1', 'refusalSettleV1', 'stairWayV1']) assert.equal(p[k], true, `${k} kept in the host's record`);
  const rules = f.db.events(f.host.worldId).filter((e) => e.kind === 'rules').length;
  f.host.stop(); f.db.close();
  const g = fixture(file); t.after(() => { g.host.stop(); g.db.close(); });
  await boot(g);
  assert.equal(g.db.events(g.host.worldId).filter((e) => e.kind === 'rules').length, rules, 'a reboot logs no rule again');
  assert.equal(guardEvents(g).length, 1); assert.equal(quarantineEvents(g).length, 1, 'quarantine/1 is adopted once, after the guard');
  assert.equal(adopting('refusalSettleV1')(g).length, 1, 'hold-settle/1 adopted once, after the guard and quarantine/1');
  assert.equal(adopting('stairWayV1')(g).length, 1, 'stair-way/1 adopted once, last');
});

// #1442: hold-settle/1 places settled bodies with the guard's own read (bodyStandsClear), so it is never adopted without it
test('#1442 hold-settle/1 is refused while body-step-guard/1 is off: a boot whose guard adoption fails never settles without bodyStandsClear', async (t) => {
  const errors: string[] = []; t.mock.method(console, 'error', (...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  const f = fixture(':memory:'); t.after(() => { f.host.stop(); f.db.close(); });
  const settleEvents = adopting('refusalSettleV1'), cfg = () => (f.host.engine as unknown as { cfg: { refusalSettleV1?: boolean; bodyStepGuardV1?: boolean } }).cfg;
  // alone, the adoption is refused and writes nothing
  const rules = f.db.events(f.host.worldId).filter((e) => e.kind === 'rules').length;
  await assert.rejects(accept<unknown>(f.host, f.host.enableRefusalSettleV1('test')), /hold-settle\.guard-required/);
  assert.equal(f.db.events(f.host.worldId).filter((e) => e.kind === 'rules').length, rules, 'nothing written');
  // a boot whose guard adoption fails: settle is not adopted, says so in the log, and the chain runs on
  t.mock.method(f.host, 'enableBodyStepGuardV1', () => Promise.reject(Error('test: the guard could not be adopted')));
  await accept<unknown>(f.host, adoptBootRuntimePoliciesV1(f.host, { edge: false, worldKey: 'eden' }));
  assert.equal(settleEvents(f).length, 0, 'hold-settle/1 is not adopted');
  assert.notEqual(policy(f)?.refusalSettleV1, true); assert.notEqual(cfg().refusalSettleV1, true, 'the engine never settles');
  assert.notEqual(cfg().bodyStepGuardV1, true, 'the guard is off, as the failed adoption left it');
  assert.ok(errors.some((l) => /hold-settle\/1 could not be adopted: Error: hold-settle\.guard-required/.test(l)), errors.join('\n'));
  assert.equal(policy(f)?.quarantineV1, true); assert.equal(policy(f)?.stairWayV1, true, 'the rest of the chain is adopted');
  // once the guard is on, the next boot adopts settle, and its event carries the guard
  t.mock.restoreAll();
  await accept<unknown>(f.host, adoptBootRuntimePoliciesV1(f.host, { edge: false, worldKey: 'eden' }));
  const [ev] = settleEvents(f); assert.ok(ev, 'adopted after the guard');
  assert.equal((ev.payload as { runtimePolicy: Record<string, unknown> }).runtimePolicy.bodyStepGuardV1, true, 'the adoption event carries the guard');
  assert.equal(cfg().refusalSettleV1, true); assert.equal(cfg().bodyStepGuardV1, true);
});

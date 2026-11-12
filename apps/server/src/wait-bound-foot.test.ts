// #1367 wait-bound/3 is one logged rules event, adopted at boot after wait-bound/2: once (a reboot logs nothing), replayed
// by a boot from the log to the live hash, and absent from a world that never adopted it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture, accept} from '../test/native-owner-fixture.ts';
import {adoptBootRuntimePoliciesV1} from './edge-runtime-rules.ts';

const adopting = (key: string) => (f: ReturnType<typeof fixture>) => f.db.events(f.host.worldId).filter((e, i, all) => e.kind === 'rules' && (e.payload as {runtimePolicy?: Record<string, unknown>}).runtimePolicy?.[key] === true
  && !all.slice(0, i).some((d) => d.kind === 'rules' && (d.payload as {runtimePolicy?: Record<string, unknown>}).runtimePolicy?.[key] === true));
const cfg = (f: ReturnType<typeof fixture>) => (f.host.engine as unknown as {cfg: Record<string, unknown>}).cfg;

test('#1367 wait-bound/3: adopted once at boot after wait-bound/2, and a boot from the log reaches the live hash with it on', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wait-bound-3-')), file = join(root, 'sim.db');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const f = fixture(file);
  assert.equal(adopting('waitBoundV3')(f).length, 0, 'a world that never adopted it has no such event');
  for (let i = 0; i < 20; i++) f.host.tickOnce();
  const before = f.host.engine.stateHash();
  await accept<unknown>(f.host, adoptBootRuntimePoliciesV1(f.host, {edge: true, worldKey: 'eden'}));
  const [two] = adopting('waitBoundV2')(f), [three] = adopting('waitBoundV3')(f);
  assert.ok(two && three && three.seq > two.seq, 'one wait-bound/3 event, after wait-bound/2');
  assert.match(String((three.payload as {why?: string}).why), /^wait-bound\/3 \(#1367\)/);
  assert.equal(cfg(f).waitBoundV3, true); assert.notEqual(f.host.engine.stateHash(), before, 'the rule is part of the state');
  const live = f.host.engine.stateHash(), tick = f.host.engine.world.tick, rules = f.db.events(f.host.worldId).filter((e) => e.kind === 'rules').length;
  f.host.stop(); f.db.close();
  const g = fixture(file); t.after(() => {g.host.stop(); g.db.close();});
  assert.equal(g.host.engine.world.tick, tick); assert.equal(g.host.engine.stateHash(), live, 'a boot from the log reaches the live hash');
  await accept<unknown>(g.host, adoptBootRuntimePoliciesV1(g.host, {edge: true, worldKey: 'eden'}));
  assert.equal(g.db.events(g.host.worldId).filter((e) => e.kind === 'rules').length, rules, 'a reboot logs no rule again');
  assert.equal(adopting('waitBoundV3')(g).length, 1);
});

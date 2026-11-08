// #1332 body-step-guard/1 is one logged rules event: adopted once (a second call logs nothing), replayed by a boot from the
// log to the live hash, and absent from a world that never adopted it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, accept } from '../test/native-owner-fixture.ts';

const guardEvents = (f: ReturnType<typeof fixture>) => f.db.events(f.host.worldId).filter((e) => e.kind === 'rules' && (e.payload as { runtimePolicy?: { bodyStepGuardV1?: boolean } }).runtimePolicy?.bodyStepGuardV1 === true);

test('body-step-guard/1: one rules event, idempotent, and a boot from the log reaches the live hash with the rule on', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'body-step-guard-')), file = join(root, 'sim.db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(file);
  const before = f.host.engine.stateHash();
  assert.equal(guardEvents(f).length, 0, 'a world that never adopted it has no such event');
  await accept(f.host, f.host.enableBodyStepGuardV1('world'));
  await accept(f.host, f.host.enableBodyStepGuardV1('world'));
  assert.equal(guardEvents(f).length, 1, 'adopted once');
  assert.equal((f.host.extra.runtimePolicy as { bodyStepGuardV1?: boolean }).bodyStepGuardV1, true);
  assert.notEqual(f.host.engine.stateHash(), before, 'the rule is part of the state');
  const live = f.host.engine.stateHash(), tick = f.host.tick;
  f.host.stop(); f.db.close();
  const g = fixture(file);
  t.after(() => { g.host.stop(); g.db.close(); });
  assert.equal(g.host.tick, tick);
  assert.equal(g.host.engine.stateHash(), live, 'a boot from the log reaches the live hash');
  await accept(g.host, g.host.enableBodyStepGuardV1('world'));
  assert.equal(guardEvents(g).length, 1, 'a booted world does not adopt it twice');
});

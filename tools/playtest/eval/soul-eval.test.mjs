import test from 'node:test';
import assert from 'node:assert/strict';
import { unmeasured, GENESIS, resolveInputs } from './soul-eval.mjs';
import { validateBattery } from './measure.mjs';
import { validateScript } from '../arena/adapters/scripted-owner.mjs';

test('#2047: a run passes only when it measured; every episode or over 20% errored fails it', () => {
  const ok = { item: 'a', succeeded: false }, err = { item: 'b', error: 'the client keeps no world copy' };
  assert.equal(unmeasured([ok, ok, ok, ok, ok]), null);
  assert.equal(unmeasured([err, ok, ok, ok, ok]), null);   // 1 of 5: at the threshold, not over it
  assert.match(unmeasured([err, err, ok, ok, ok]), /2 of 5 episodes errored, over the declared 20%.*no world copy/);
  assert.match(unmeasured([err, err]), /measured nothing: all 2 episode\(s\) errored/);
  assert.match(unmeasured([]), /measured nothing: no episode ran/);
});

test('#2446: m4-hamlet-v1 names hello-hamlet, which the eval can boot; every m4-v1 item is ported or listed as not', () => {
  const { battery, seatCfg } = resolveInputs({ battery: 'm4-hamlet-v1', seat: 'scripted' });
  assert.equal(battery.world, 'hello-hamlet');
  assert.ok(GENESIS[battery.world]);
  assert.deepEqual(validateBattery(battery), []);
  assert.deepEqual(validateScript(seatCfg.script), []);
  for (const it of battery.items) assert.ok(seatCfg.script.rules.some((r) => new RegExp(r.match).test(it.instruction)), `no scripted rule for ${it.id}`);
  const m4 = resolveInputs({ battery: 'm4-v1', seat: 'scripted' }).battery.items.map((i) => i.id).sort();
  assert.deepEqual([...battery.items.map((i) => i.from), ...battery.notPorted.map((n) => n.id)].sort(), m4);
  assert.ok(battery.notPorted.every((n) => n.why));
});

test('#2468: harder-hamlet-v1 names hello-hamlet; every harder-v1 item is ported or listed as not; the scripted seat covers each instruction', () => {
  const { battery, seatCfg } = resolveInputs({ battery: 'harder-hamlet-v1', seat: 'scripted' });
  assert.equal(battery.world, 'hello-hamlet');
  assert.ok(GENESIS[battery.world]);
  assert.deepEqual(validateBattery(battery), []);
  assert.deepEqual(validateScript(seatCfg.script), []);
  for (const it of battery.items.filter((i) => i.instruction !== null)) assert.ok(seatCfg.script.rules.some((r) => new RegExp(r.match, 'i').test(it.instruction)), `no scripted rule for ${it.id}`);
  const harder = resolveInputs({ battery: 'harder-v1', seat: 'scripted' }).battery.items.map((i) => i.id).sort();
  assert.deepEqual([...battery.items.map((i) => i.from), ...battery.notPorted.map((n) => n.id)].sort(), harder);
  assert.ok(battery.notPorted.every((n) => n.why));
});

test('#2477: harder-hamlet-v2 is v1 with the cottage bench\'s wording and the 3600 s cap fixed; v1 stays as scored', () => {
  const v1 = resolveInputs({ battery: 'harder-hamlet-v1', seat: 'scripted' }).battery, v2 = resolveInputs({ battery: 'harder-hamlet-v2', seat: 'claude-sonnet' }).battery;
  assert.deepEqual(validateBattery(v2), []);
  assert.equal(v2.world, 'hello-hamlet');
  const item = (b, id) => b.items.find((i) => i.id === id);
  assert.match(item(v2, 'errand-three-step').instruction, /^Sit on the cottage's bench, then/);
  assert.match(item(v1, 'errand-three-step').instruction, /^Sit on the bench in the cottage, then/, 'v1 unchanged');
  assert.match(item(v2, 'refused-recover').note, /at most 3600 s/);
  assert.deepEqual(v2.items.map((i) => [i.id, i.check]), v1.items.map((i) => [i.id, i.check]), 'the same checks');
});

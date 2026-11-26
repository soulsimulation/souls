import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENTRIES, sceneOf, foundId, requireDone, requireField, terminalReceipt, meal } from './meal.mjs';
const entries = ENTRIES.map((p) => JSON.parse(readFileSync(resolve('content/kinds', p + '.json'), 'utf8')));

test('the scene keeps original entry defaults and the bowl on the only serving shelf', () => {
  const scene = sceneOf(entries), ops = scene.template.batches[0].ops;
  const pot = ops.find((o) => o.def?.name === 'meal-camp-soup-pot').def;
  assert.equal(pot.state.soup.default, 0);
  assert.equal(pot.state.vegetables.default, 3);
  assert.equal(pot.slots[0].id, 'shelf');
  assert.deepEqual(pot.slots[0].p, [0.3, 0.96, 0]);
  const bowl = ops.find((o) => o.name === 'meal-bowl');
  assert.deepEqual(bowl.in, { parent: '$pot', slot: 'shelf' });
  assert.equal(scene.map.rows.find((r) => r.def === bowl.def).entry, 'eden:soup_bowl');
  assert.equal(scene.map.rows.length, entries.length);
});

test('a refusal or an unfinished receipt never counts as completed work', () => {
  for (const answer of [{ ok: false, phase: 'refused', code: 'not-held' }, { ok: true, phase: 'started' }, { ok: true }, { phase: 'done' }]) {
    assert.throws(() => requireDone(answer, 'take bowl'));
  }
  assert.equal(requireDone({ ok: true, phase: 'done' }, 'take bowl').phase, 'done');
});

test('quantity evidence must name the exact value, with no missing-field success', () => {
  requireField({ state: { soup: 2 } }, 'soup', 2, 'serving');
  requireField({ state: { cooked: 0 } }, 'cooked', false, 'raw pot');
  requireField({ state: { cooked: true } }, 'cooked', true, 'cooked pot');
  assert.throws(() => requireField({ state: { cooked: 2 } }, 'cooked', true, 'invalid boolean'));
  assert.throws(() => requireField({ state: { soup: 1 } }, 'soup', 2, 'serving'));
  assert.throws(() => requireField({ state: {} }, 'soup', 2, 'serving'));
});

test('native identifiers come from a unique named client result, never from scene ids', () => {
  assert.equal(foundId({ found: [{ name: 'soup-pot', id: 'native-pot' }] }, 'soup-pot'), 'native-pot');
  assert.throws(() => foundId({ found: [] }, 'soup-pot'));
  assert.throws(() => foundId({ found: [{ name: 'soup-pot' }, { name: 'soup-pot' }] }, 'soup-pot'));
});

test('a real refusal stops the workflow before any food or ownership claim', async () => {
  const calls = [], seats = ['cook', 'server', 'diner'].map((label) => ({ label, run: async (...words) => {
    calls.push({ label, words }); return { ok: false, phase: 'refused', code: 'world-not-ready' };
  } })), report = { complete: false, steps: [] };
  await assert.rejects(meal({ seats, report }), /world-not-ready/);
  assert.equal(calls.length, 1);
  assert.equal(report.complete, false);
  assert.equal(report.steps.length, 1);
});

test('set-down waits for its final receipt rather than treating sent as success', () => {
  assert.equal(terminalReceipt({ ok: true, sequence: 14, sent: true }), null);
  assert.equal(terminalReceipt({ receipt: { answers: [{ answer: 'accepted' }] } }), null);
  assert.equal(terminalReceipt({ receipt: { answers: [{ answer: 'accepted' }, { answer: 'receipt' }] } }).phase, 'done');
  const refused = terminalReceipt({ receipt: { answers: [{ answer: 'refused', reason: 'setdown.no-room' }] } });
  assert.equal(refused.phase, 'refused');
  assert.throws(() => requireDone(refused, 'return bowl'));
});

test('already arrived Souls are not joined a second time', async () => {
  const calls = [], seats = ['cook', 'server', 'diner'].map(label => ({ label, run: async (...words) => {
    calls.push(words); return words[0] === 'status' ? { ok: true, in_world: true, body: label + '-body' } : { ok: true, found: [] };
  } }));
  await assert.rejects(meal({ seats, report: { complete: false, steps: [] } }), /expected one named thing/);
  assert.equal(calls.filter(w => w[0] === 'status').length, 3);
  assert(!calls.some(w => w.includes('life:join')));
});

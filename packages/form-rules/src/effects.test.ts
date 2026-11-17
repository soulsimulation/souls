import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, effects, type Done, type State } from './effects.ts';
import { generate } from './generate.ts';
import { CASES, loadEffectCases, loadKinds, mismatches, same } from './load.ts';

const kinds = loadKinds();
const cases = loadEffectCases();

// A1, A3 and A4: each case does its acts in order through `effects` and `apply`, with no engine, and checks
// each result and the state after. A2 on every act that is done: applying it again with its receipt changes nothing.
for (const [file, c] of cases) {
  test(`${file.slice(CASES.length + 1)}: ${c.name}`, () => {
    let state: State = structuredClone(c.state);
    c.do.forEach((step, k) => {
      const result = effects({ kinds, act: step.act, state: { ...state, actor: step.actor ?? state.actor }, receipt: step.receipt });
      if (step.expect) assert.deepEqual(mismatches(step.expect, result), [], `step ${k}: ${JSON.stringify(result)}`);
      const once = apply(state, result);
      if (!once.ok) return assert.fail(`step ${k}: ${JSON.stringify(once)}`);
      if (result.verdict !== 'yes') {
        assert.equal('changes' in result, false, `step ${k}: a refusal carries no changes`);
        assert.equal(once.state, state, `step ${k}: a refusal leaves the state as it was`);
        return;
      }
      const twice = apply(once.state, result);
      assert.ok(twice.ok && twice.again, `step ${k}: the receipt is known`);
      assert.deepEqual(twice.ok && twice.state, once.state, `step ${k}: applied twice is applied once`);
      state = once.state;
    });
    for (const [id, want] of Object.entries(c.after ?? {})) assert.ok(same(state.nodes[id] ?? null, want), `${id}: ${JSON.stringify(state.nodes[id] ?? null)}`);
  });
}

const steps = cases.flatMap(([, c]) => c.do.map((s) => ({ kind: c.state.nodes[s.act.this]?.kind, ...s })));

test('A1: fill a kettle, pour into a cup, take a cup from a shelf and sign up on a sheet each have their changes and events', () => {
  for (const [kind, form] of [['test:kettle', 'fill'], ['test:kettle', 'pour'], ['test:cup', 'take'], ['test:sheet', 'sign_up']]) {
    const done = steps.filter((s) => s.kind === kind && s.act.form === form && s.expect?.verdict === 'yes');
    assert.ok(done.some((s) => Array.isArray(s.expect!.changes) && Array.isArray(s.expect!.events)), `${kind} ${form}`);
  }
});

test('A3: a pour that would overflow is refused by the rules (a need, no_room)', () => {
  const refused = steps.filter((s) => s.kind === 'test:kettle' && s.act.form === 'pour' && s.expect?.reason === 'no_room');
  assert.ok(refused.length > 0);
  for (const s of refused) assert.equal(typeof s.expect!.need, 'number', 'refused by a need, before any effect is worked out');
});

test('A4: every form of the published kettle, bench and lecture is done in a case, with its changes', () => {
  for (const kind of ['eden:kettle', 'eden:bench', 'eden:lecture']) {
    for (const form of Object.keys(kinds[kind].forms ?? {})) {
      assert.ok(steps.some((s) => s.kind === kind && s.act.form === form && s.expect?.verdict === 'yes' && Array.isArray(s.expect.changes)), `${kind} ${form}`);
    }
  }
});

test('A2 over 1,000 generated acts: never throws, and whatever is done applies once per receipt', () => {
  let done = 0;
  for (const [k, input] of generate(kinds, 1000, 2844).entries()) {
    const result = effects({ kinds, act: input.act, state: input.state, receipt: `g${k}` });
    if (result.verdict !== 'yes') continue;
    done++;
    const once = apply(input.state, result);
    assert.ok(once.ok, JSON.stringify(once));
    const twice = apply(once.ok ? once.state : input.state, result);
    assert.ok(twice.ok && twice.again);
    assert.deepEqual(twice.ok && twice.state, once.ok && once.state);
  }
  assert.ok(done > 0, 'some generated acts are done');
});

test('amounts that do not sum to zero are refused, and a batch applies whole or not at all', () => {
  const state: State = { actor: 'b1', nodes: { k1: { kind: 'test:kettle', fields: { water_g: 10 } }, c1: { kind: 'test:cup' } } };
  const result = (changes: Done['changes']): Done => ({ verdict: 'yes', receipt: 'x', actor: 'b1', changes, events: [{ event: 'poured', node: 'k1', changes: [0, 1] }], timers: [] });
  const out = { change: 'set', node: 'k1', field: 'water_g', n: 1, to: 5, by: -5 } as const;
  assert.deepEqual(apply(state, result([out, { change: 'set', node: 'c1', field: 'water_g', n: 1, to: 6, by: 6 }])), { ok: false, reason: 'amounts_do_not_balance', change: 0 });
  assert.deepEqual(apply(state, result([out, { change: 'set', node: 'gone', field: 'water_g', n: 1, to: 5, by: 5 }])), { ok: false, reason: 'no_such_node', change: 1 });
  assert.deepEqual(state.nodes.k1.fields, { water_g: 10 }, 'the first change of a refused batch is not applied');
});

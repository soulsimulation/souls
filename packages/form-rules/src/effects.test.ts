import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, effects, outsideProfile, type Done, type State } from './effects.ts';
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
      const result = effects({ kinds, act: step.act, state: { ...state, actor: step.actor ?? state.actor, now_us: step.now_us ?? state.now_us }, receipt: step.receipt, draw: step.draw });
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

const board: State = { actor: 'b1', nodes: { room: { loose: ['b1', 'd1', 'a1'] }, d1: { kind: 'test:dartboard' }, a1: { kind: 'test:dart' }, b1: { hands: { left: null, right: 'a1' } } } };
const throwAt = { this: 'd1', form: 'throw', args: {} };

test('SA-F13 A1: every row of a dartboard is reached by some draw, and a draw below the total always lands on a row', () => {
  const seen = new Set<string>();
  for (let r = 0; r < 10; r++) {
    const done = effects({ kinds, act: throwAt, state: board, receipt: `d${r}`, draw: [r] });
    assert.equal(done.verdict, 'yes');
    if ('events' in done) seen.add(done.events[0].outcome!);
  }
  assert.deepEqual([...seen].sort(), ['bull', 'miss', 'single']);
});

test('SA-F13 A2: with no draw the answer is unknown and lists every outcome, and it changes nothing', () => {
  const answer = effects({ kinds, act: throwAt, state: board, receipt: 'u1' });
  assert.equal(answer.verdict, 'unknown');
  assert.deepEqual('could_be' in answer && answer.could_be.map((o) => o.outcome), ['miss', 'single', 'bull']);
  assert.ok(!('changes' in answer));
  const kept = apply(board, answer);
  assert.ok(kept.ok && kept.state === board);
});

test('SA-F13: a weight is a whole number or one whole-number field, and nothing else', () => {
  const entry = (weight: unknown) => ({ ...kinds['test:die'], state: { face: { n: 1, type: 'int', default: 1, audience: 'public' }, label: { n: 2, type: 'text', default: null, audience: 'public' } }, forms: { roll: { ...kinds['test:die'].forms!.roll, effects: [{ change: 'draw', outcomes: [{ name: 'a', weight, event: 'test:a', set: [] }] }] } } });
  const state: State = { actor: 'b1', nodes: { room: { loose: ['b1'] }, x1: { kind: 'test:die' }, b1: { hands: { right: 'x1' } } } };
  const roll = (weight: unknown) => effects({ kinds: { ...kinds, 'test:die': entry(weight) as never }, act: { this: 'x1', form: 'roll', args: {} }, state, receipt: 'w', draw: [0] });
  for (const bad of [-1, 0, 1.5, '3', { field: 'label' }, { field: 'nope' }, { field: 'face', plus: 1 }, null]) assert.equal(roll(bad).verdict, 'no', JSON.stringify(bad));
  assert.equal(roll({ field: 'face' }).verdict, 'yes');
});

// Every result, done step by step: the hand-written cases' acts and 1,000 generated ones.
function results(): Done[] {
  const out: Done[] = [];
  for (const [, c] of cases) {
    let state: State = structuredClone(c.state);
    for (const step of c.do) {
      const result = effects({ kinds, act: step.act, state: { ...state, actor: step.actor ?? state.actor, now_us: step.now_us ?? state.now_us }, receipt: step.receipt });
      const once = apply(state, result);
      if (result.verdict === 'yes' && 'changes' in result && once.ok) (out.push(result), (state = once.state));
    }
  }
  for (const [k, input] of generate(kinds, 1000, 2844).entries()) {
    const result = effects({ kinds, act: input.act, state: input.state, receipt: `g${k}` });
    if (result.verdict === 'yes' && 'changes' in result) out.push(result);
  }
  return out;
}

test('T0 values: every change, event and timer of every result is inside Engine v2\'s encoding profile', () => {
  const all = results();
  assert.ok(all.some((r) => r.changes.some((c) => c.change === 'set' && typeof c.to === 'number' && c.n === 2 && c.field === 'heating')), 'a flag is set');
  for (const r of all) {
    for (const [what, list] of [['change', r.changes], ['event', r.events], ['timer', r.timers]] as const) {
      list.forEach((item, k) => assert.equal(outsideProfile(item), null, `${r.receipt} ${what} ${k}: ${JSON.stringify(item)}`));
    }
  }
});

test('T0 values: a value outside the profile is refused by name, and apply refuses it', () => {
  for (const [value, refused] of [[true, 'simple'], [false, 'simple'], [undefined, 'simple'], [null, 'null'], [0.5, 'float'], [2 ** 53, 'unsafe-integer'], ['two words', 'text-not-name'], ['é', 'text-not-name']] as const) {
    assert.deepEqual(outsideProfile({ to: value }), { at: '/to', refused }, String(value));
  }
  assert.equal(outsideProfile({ to: { text: 't_ethics' }, by: -5, n: 9007199254740991, big: 2n ** 63n }), null);
  const state: State = { actor: 'b1', nodes: { k1: { kind: 'eden:kettle', fields: { heating: 0 } } } };
  const result: Done = { verdict: 'yes', receipt: 'x', actor: 'b1', changes: [{ change: 'set', node: 'k1', field: 'heating', n: 2, to: true }], events: [], timers: [] };
  assert.deepEqual(apply(state, result), { ok: false, reason: 'simple', change: 0, at: '/to' });
  assert.deepEqual(apply(state, { ...result, changes: [], events: [{ event: 'eden:on', node: 'k1', changes: [], extra: null } as never] }), { ok: false, reason: 'null', event: 0, at: '/extra' });
});

test('T0 values: a missing text argument is left out, and a set without a value clears the field', () => {
  const state: State = { actor: 'b1', nodes: { room: { loose: ['b1', 'l1'] }, l1: { kind: 'eden:lecture', fields: { topic: { text: 't_old' } } }, b1: { hands: {} } } };
  const result = effects({ kinds, act: { this: 'l1', form: 'begin', args: {} }, state, receipt: 'r1' });
  assert.equal(result.verdict, 'yes');
  const set = (result as Done).changes[1];
  assert.deepEqual(set, { change: 'set', node: 'l1', field: 'topic', n: 2 });
  const after = apply(state, result);
  assert.ok(after.ok);
  assert.deepEqual(after.ok && after.state.nodes.l1.fields, { running: 1 });
});

test('event names are namespace:name, the declaring kind\'s namespace before the name the entry writes', () => {
  for (const r of results()) for (const e of r.events) assert.match(e.event, /^[a-z0-9_]+:[a-z0-9_]+$/, e.event);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, effects, type State } from './effects.ts';
import { CASES, loadKinds, mismatches, PACKAGE, same } from './load.ts';
import { checkReactions, react, REACTION_EFFECTS, TRIGGERS, type Cause, type Kinds } from './reactions.ts';

const kinds = loadKinds() as Kinds;
const read = (file: string, format: string) => {
  const doc = JSON.parse(readFileSync(join(CASES, file), 'utf8'));
  assert.equal(doc.format, format, file);
  return doc.cases;
};
type ReactCase = { name: string; state: State & { world?: string }; cause: Cause; receipt: string; expect: Record<string, unknown>; after?: Record<string, unknown> };
const cases: ReactCase[] = read('react/five.json', 'souls-react-cases/1');
const checks: { name: string; kinds: Kinds[string][]; expect: unknown[] }[] = read('react/check/refused.json', 'souls-react-check-cases/1');

// A1: each case's cause, through the rules, gives the expected rules started, changes and events; `after` is the state
// once the cause and those changes are applied (with `apply`, as a form's are). Adding a case changes no code.
for (const c of cases) {
  test(`react/five.json: ${c.name}`, () => {
    const result = react({ kinds, state: c.state, cause: c.cause, receipt: c.receipt });
    assert.deepEqual(mismatches(c.expect, result), [], JSON.stringify(result));
    let state: State = structuredClone(c.state);
    if ('change' in c.cause) {
      const caused = apply(state, { verdict: 'yes', receipt: `${c.receipt}.cause`, actor: 'world', changes: [c.cause], events: [], timers: [] });
      assert.ok(caused.ok, JSON.stringify(caused));
      state = caused.state;
    }
    const after = apply(state, result as never);
    assert.ok(after.ok, JSON.stringify(after));
    for (const [id, want] of Object.entries(c.after ?? {})) assert.ok(same(after.state.nodes[id] ?? null, want), `${id}: ${JSON.stringify(after.state.nodes[id] ?? null)}`);
  });
}

test('A1: the five examples validate', () => {
  const five = ['test:wall_switch', 'test:lamp', 'test:street_lamp', 'test:stove_kettle', 'test:shop', 'test:chime_door'];
  for (const k of five) assert.ok(kinds[k], k);
  assert.deepEqual(checkReactions(kinds), []);
});

test('A1: a switch sets three linked lamps; dusk lights a street lamp; a kettle on a lit stove gains a rate', () => {
  const by = (name: string) => cases.find((c) => c.name === name)!;
  const lamps = react({ kinds, ...by('switch_on_lights_its_three_lamps') });
  assert.ok(lamps.verdict === 'yes' && new Set(lamps.changes.map((x) => x.node)).size === 3);
  const dusk = react({ kinds, ...by('dusk_lights_the_street_lamp') });
  assert.ok(dusk.verdict === 'yes' && same(dusk.changes, [{ change: 'set', node: 's1', field: 'lit', n: 1, to: 1 }]));
  for (const name of ['stove_lit_under_the_kettle_gives_it_a_rate', 'kettle_put_on_a_lit_stove_gives_it_a_rate']) {
    const kettle = react({ kinds, ...by(name) });
    assert.ok(kettle.verdict === 'yes' && (kettle.changes[0] as { to: { per_s: number } }).to.per_s === 800, name);
  }
});

test('A1: the shop closes at six with a timer of fourteen hours, and that timer coming due opens it', () => {
  const state = { actor: 'b1', nodes: { sh: { kind: 'test:shop', fields: { open: true }, links: { owner: ['s1'] } }, b1: { kind: 'test:walker', links: { soul: ['s1'] } } } };
  const closed = effects({ kinds, act: { this: 'sh', form: 'close_until_eight' }, state, receipt: 'close' });
  assert.ok(closed.verdict === 'yes' && 'timers' in closed, JSON.stringify(closed));
  assert.deepEqual(closed.timers, [{ node: 'sh', form: 'opening', after_us: 14 * 3600 * 1000000, event: 1 }]);
  const after = apply(state, closed);
  assert.ok(after.ok && same(after.state.nodes.sh.fields, { open: 0 }));
  const opened = react({ kinds, state: after.state, cause: { due: closed.timers[0].form, node: 'sh' }, receipt: 'due' });
  assert.ok(opened.verdict === 'yes' && same(opened.changes, [{ change: 'set', node: 'sh', field: 'open', n: 1, to: 1 }]));
});

// A2 and A3: each check case's kinds, loaded in its order, give exactly the expected errors.
for (const c of checks) {
  test(`react/check/refused.json: ${c.name}`, () => {
    const set: Kinds = {};
    for (const k of c.kinds) set[k.kind] = k;
    assert.deepEqual(checkReactions(set), c.expect);
  });
}

test('A2: a pair of rules that feed each other is refused, naming the cycle; A3: a body, an offer or a draw is refused', () => {
  const reasons = checks.flatMap((c) => (c.expect as { reason: string }[]).map((e) => e.reason));
  for (const r of ['cycle', 'acts_on_body', 'acts_on_offer', 'draws']) assert.ok(reasons.includes(r), r);
  const cycles = checks.flatMap((c) => c.expect as { reason: string; cycle?: string[]; rules?: string[] }[]).filter((e) => e.reason === 'cycle');
  for (const e of cycles) assert.ok(e.cycle!.length >= 2 && e.cycle![0] === e.cycle!.at(-1) && e.rules!.length === e.cycle!.length - 1);
});

test('the two closed lists are E18s, in one file, and every rule of every kind uses only them', () => {
  const lists = JSON.parse(readFileSync(join(PACKAGE, 'src/reactions.json'), 'utf8'));
  assert.deepEqual(TRIGGERS, ['changed', 'linked_changed', 'support_changed', 'rested', 'left', 'body_entered', 'body_left', 'due', 'world']);
  assert.deepEqual(REACTION_EFFECTS, ['set', 'add', 'rate']);
  assert.deepEqual(Object.keys(lists.triggers), TRIGGERS);
  for (const entry of Object.values(kinds)) {
    for (const r of Object.values(entry.reactions ?? {})) {
      assert.ok(TRIGGERS.includes(r.when.on));
      for (const e of r.do) assert.ok(REACTION_EFFECTS.includes(e.change));
    }
  }
});

test('never throws, whatever it is given', () => {
  const junk: unknown[] = [null, {}, { kinds, state: {}, cause: {}, receipt: 'x' }, { kinds, state: { nodes: {} }, cause: { change: 'set', node: 'nope' }, receipt: 'x' }, { kinds, state: { nodes: { a: {} } }, cause: { due: 7, node: 'a' }, receipt: 'x' }];
  for (const j of junk) assert.equal(react(j as never).verdict, 'no');
  for (const j of [{ 'test:x': { kind: 'test:x', reactions: 7 } }, { 'test:x': { kind: 'test:x', reactions: { r: { when: null, do: null } } } }]) assert.ok(checkReactions(j as never).length > 0);
});

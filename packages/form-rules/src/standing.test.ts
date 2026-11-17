// A standing activity: members that outlast a sitting, a sitting that starts when enough are present, and an end date
// (Soul Actions SA-G2, #2874). The cases in cases/activity/standing/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { test } from 'node:test';
import { enter, join, lapse, leave, nowLine, standingOf, STANDING_PARTS, type Activity } from './activity.ts';
import { apply, effects, parentOf, type State } from './effects.ts';
import { CASES, loadKinds, mismatches, same } from './load.ts';
import type { Input } from './rules.ts';

type Step = { do: 'join' | 'enter' | 'leave' | 'world' | 'now'; actor?: string; form?: string; receipt?: string; now_us?: number; expect: Record<string, unknown> };
type StepCase = { name: string; activity: string; state: { nodes: Input['state']['nodes'] }; steps: Step[]; after?: Record<string, unknown>; gone?: string[] };

const kinds = loadKinds();
const DIR = joinPath(CASES, 'activity', 'standing');
const cases: [string, StepCase][] = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(joinPath(DIR, file), 'utf8'));
  assert.equal(doc.format, 'souls-activity-steps/1', file);
  for (const c of doc.cases) cases.push([file, c]);
}

type Seen = { step: Step; result: Record<string, unknown>; before: State; after: State };
const runs = new Map<string, Seen[]>();
const isBody = (nodes: State['nodes'], id: string) => !!nodes[id] && !nodes[id].kind && 'hands' in nodes[id];

for (const [file, c] of cases) {
  test(`activity/standing/${file}: ${c.name}`, () => {
    let state: State = structuredClone({ actor: '', ...c.state });
    const seen: Seen[] = [];
    c.steps.forEach((step, k) => {
      const act = { this: c.activity, form: step.form ?? '' };
      const asker = { sees: ['public'] };
      const as = { ...state, actor: step.actor ?? '' };
      let result: Record<string, unknown>;
      if (step.do === 'now') result = nowLine({ kinds, state, node: c.activity, asker });
      else if (step.do === 'join') result = join({ kinds, act, state: as, asker, receipt: step.receipt! });
      else if (step.do === 'enter') result = enter({ kinds, act, state: as, asker, receipt: step.receipt! });
      else if (step.do === 'leave') result = leave({ kinds, act, state: as, asker, receipt: step.receipt! });
      else result = lapse({ kinds, act, state: { ...as, now_us: step.now_us }, receipt: step.receipt! });
      assert.deepEqual(mismatches(step.expect, result), [], `step ${k}: ${JSON.stringify(result)}`);
      const before = state;
      if (step.do !== 'now' && result.verdict === 'yes') {
        const done = apply(state, result as Parameters<typeof apply>[1]);
        if (!done.ok) return assert.fail(`step ${k}: ${JSON.stringify(done)}`);
        state = { ...done.state, actor: '' };
      }
      // The world and the joining form move no body: ending a class leaves every Soul where it was.
      if (step.do === 'world' || step.do === 'join') {
        for (const id of Object.keys(before.nodes).filter((id) => isBody(before.nodes, id))) assert.deepEqual(parentOf(state.nodes, id), parentOf(before.nodes, id), `step ${k}: ${id} moved`);
      }
      seen.push({ step, result, before, after: state });
    });
    for (const [id, want] of Object.entries(c.after ?? {})) assert.ok(same(state.nodes[id] ?? null, want), `${id}: ${JSON.stringify(state.nodes[id] ?? null)}`);
    for (const id of c.gone ?? []) assert.equal(state.nodes[id], undefined, `${id} is removed`);
    runs.set(c.name, seen);
  });
}

const all = () => [...runs.values()].flat();
const events = (s: Seen) => ((s.result.events ?? []) as { event: string }[]).map((e) => e.event);

test('A1: three present start a sitting, checked as each arrives, and once', () => {
  const seen = runs.get('three_present_start_a_sitting')!;
  const arrivals = seen.filter((s) => s.step.do === 'enter' && s.result.verdict === 'yes');
  assert.deepEqual(arrivals.map((s) => events(s).includes('test:sitting_began')), [false, false, true, false]);
});

test('A1: all leave and the class remains with its state and end date; the sitting ends with the last one up', () => {
  const seen = runs.get('all_leave_and_the_class_remains')!;
  assert.ok(seen.every((s) => s.result.ended === undefined || s.result.ended === 0));
  const rose = seen.filter((s) => s.step.form === 'rise' && s.result.verdict === 'yes');
  assert.deepEqual(rose.map((s) => events(s).includes('test:sitting_ended')), [false, false, true]);
  const empty = seen.find((s) => s.step.do === 'leave' && s.step.receipt === 'p5')!;
  assert.deepEqual(empty.after.nodes.c1.links?.member, []);
  assert.ok(empty.after.nodes.c1, 'the class stands with no member');
});

test('A1: at its end date the class is removed, every member released first, and not a microsecond before', () => {
  const seen = runs.get('at_its_end_date_the_class_is_removed_members_released_bodies_kept')!;
  const stated = (seen.find((s) => s.step.do === 'now')!.result as { now: { ends_us: number } }).now.ends_us;
  const yes = seen.find((s) => s.step.do === 'world' && s.result.verdict === 'yes')!;
  assert.equal(yes.step.now_us, stated);
  assert.ok(seen.some((s) => s.step.do === 'world' && s.step.now_us === stated - 1 && s.result.verdict === 'no'));
  assert.deepEqual(events(yes), ['test:released', 'lapsed']);
  const changes = yes.result.changes as { change: string; link?: string; end?: string }[];
  assert.equal(changes.filter((c) => c.change === 'unlink').length, 6);
  assert.equal(changes.at(-1)!.change, 'remove');
});

test('the standing section uses only the closed list and is whole', () => {
  const entry = kinds['test:class'] as Activity;
  assert.deepEqual(Object.keys(entry.standing!).filter((k) => !STANDING_PARTS.includes(k)), []);
  assert.ok(!('bad' in (standingOf(entry) as object)));
  for (const mutate of [(s: Record<string, unknown>) => (s.enough = 6), (s: Record<string, unknown>) => (s.enough = 0), (s: Record<string, unknown>) => (s.stage = 'left_us'), (s: Record<string, unknown>) => (s.members = s.present), (s: Record<string, unknown>) => (s.extra = 1), (s: Record<string, unknown>) => (s.sitting = s.idle)]) {
    const bad = structuredClone(entry) as Activity;
    mutate(bad.standing as unknown as Record<string, unknown>);
    assert.deepEqual(standingOf(bad), { bad: 'malformed_standing' });
  }
  assert.equal(standingOf(kinds['test:talk'] as Activity), null);
});

test('a one-off activity still ends when its last member leaves, and joining refuses what is not a joining form', () => {
  const state: State = { actor: 'b1', nodes: { r1: { loose: ['c1', 'b1'] }, c1: { kind: 'test:class', links: { member: ['b1'] } }, b1: { hands: {} } } };
  const r = join({ kinds, act: { this: 'c1', form: 'arrive' }, state, asker: { sees: 'all' }, receipt: 'z' });
  assert.equal(r.verdict, 'no');
  assert.equal(effects({ kinds, act: { this: 'c1', form: 'lapse' }, state, receipt: 'z' }).verdict, 'no');
});

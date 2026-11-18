// Leaving an activity, its "now" line and its end (Soul Actions SA-G1b, #2873). The cases in cases/activity/leave/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { enter, leave, NOW_PARTS, nowLine, ROLE_NEEDS, type Activity } from './activity.ts';
import { apply, effects, parentOf, type State } from './effects.ts';
import { CASES, loadKinds, mismatches, same } from './load.ts';
import type { Input, Int } from './rules.ts';

type Step = { do: 'enter' | 'leave' | 'world' | 'now'; actor?: string; form?: string; receipt?: string; now_us?: number; expect: Record<string, unknown> };
type StepCase = { name: string; activity: string; state: { nodes: Input['state']['nodes'] }; steps: Step[]; after?: Record<string, unknown>; gone?: string[] };

const kinds = loadKinds();
const DIR = join(CASES, 'activity', 'leave');
const cases: [string, StepCase][] = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  assert.equal(doc.format, 'souls-activity-steps/1', file);
  for (const c of doc.cases) cases.push([file, c]);
}

type Seen = { activity: string; step: Step; result: Record<string, unknown>; before: State; after: State };
const runs = new Map<string, Seen[]>();
const isBody = (nodes: State['nodes'], id: string) => !!nodes[id] && !nodes[id].kind && 'hands' in nodes[id];

for (const [file, c] of cases) {
  test(`activity/leave/${file}: ${c.name}`, () => {
    let state: State = structuredClone({ actor: '', ...c.state });
    const seen: Seen[] = [];
    c.steps.forEach((step, k) => {
      const act = { this: c.activity, form: step.form ?? '' };
      const asker = { sees: ['public'] };
      let result: Record<string, unknown>;
      if (step.do === 'now') result = nowLine({ kinds, state, node: c.activity, asker });
      else if (step.do === 'enter') result = enter({ kinds, act, state: { ...state, actor: step.actor! }, asker, receipt: step.receipt! });
      else if (step.do === 'leave') result = leave({ kinds, act, state: { ...state, actor: step.actor! }, asker, receipt: step.receipt! });
      // The world's own form, run as the engine's timer runs it, at the time it comes due.
      else result = effects({ kinds, act, state: { ...state, actor: step.actor!, now_us: step.now_us }, receipt: step.receipt! });
      assert.deepEqual(mismatches(step.expect, result), [], `step ${k}: ${JSON.stringify(result)}`);
      const before = state;
      if (step.do !== 'now' && result.verdict === 'yes') {
        const done = apply(state, result as Parameters<typeof apply>[1]);
        if (!done.ok) return assert.fail(`step ${k}: ${JSON.stringify(done)}`);
        state = { ...done.state, actor: '' };
      }
      // No step removes a body: whatever ends, every Soul's body is still somewhere.
      for (const id of Object.keys(before.nodes).filter((id) => isBody(before.nodes, id))) {
        assert.ok(state.nodes[id], `step ${k}: body ${id} removed`);
        assert.ok(parentOf(state.nodes, id), `step ${k}: body ${id} is nowhere`);
      }
      seen.push({ activity: c.activity, step, result, before, after: state });
    });
    for (const [id, want] of Object.entries(c.after ?? {})) assert.ok(same(state.nodes[id] ?? null, want), `${id}: ${JSON.stringify(state.nodes[id] ?? null)}`);
    for (const id of c.gone ?? []) assert.equal(state.nodes[id], undefined, `${id} is removed`);
    runs.set(c.name, seen);
  });
}

const all = () => [...runs.values()].flat();

test('A1: the speaker leaves: the rules release every member and remove the activity', () => {
  const ends = all().filter((s) => s.step.do === 'leave' && s.result.verdict === 'yes' && s.result.role === 'speaker');
  assert.ok(ends.length >= 1);
  for (const s of ends) {
    const id = s.activity, ns = s.before.nodes[id].kind!.split(':')[0];
    const members = Object.values(s.before.nodes[id].links ?? {}).flat() as string[];
    const listeners = (s.before.nodes[id].links?.listener ?? []) as string[];
    assert.ok(listeners.length >= 3, 'a talk with listeners');
    assert.equal(s.result.ended, 1);
    assert.equal(s.after.nodes[id], undefined, 'the activity is removed');
    // Released: no link of the activity is left, and every member is still where it was, or loose in the place.
    const changes = s.result.changes as { change: string; node: string; link?: string; end?: string }[];
    for (const m of members) assert.ok(changes.some((c) => c.change === 'unlink' && c.node === id && c.end === m), `${m} unlinked`);
    for (const m of listeners) assert.deepEqual(parentOf(s.after.nodes, m), parentOf(s.before.nodes, m), `${m} stays seated`);
    const events = (s.result.events as { event: string }[]).map((e) => e.event);
    assert.deepEqual(events.slice(-2), [`${ns}:released`, `${ns}:ended`]);
  }
});

test('A2: an activity nobody entered is removed at its stated time, and not a microsecond before', () => {
  const lapsed = [...runs.values()].filter((seen) => seen.some((s) => s.step.do === 'world' && s.result.verdict === 'yes'));
  assert.ok(lapsed.length >= 1);
  for (const seen of lapsed) {
    // Times compared by value as big integers: `ends_us` is SA-F5a's Int (a number when safe, else a BigInt).
    const ends = BigInt((seen.find((s) => s.step.do === 'now')!.result as { now: { ends_us: Int } }).now.ends_us);
    const yes = seen.find((s) => s.step.do === 'world' && s.result.verdict === 'yes')!;
    assert.equal(BigInt(yes.step.now_us!), ends, 'removed at the time the now line states');
    assert.ok(seen.some((s) => s.step.do === 'world' && BigInt(s.step.now_us!) === ends - 1n && s.result.verdict === 'no'), 'not one microsecond before');
    assert.ok(seen.every((s) => s.step.do !== 'enter'), 'nobody entered');
  }
});

test('a seated member is never removed for being quiet: the time passing refuses while anyone is in it', () => {
  const quiet = all().filter((s) => s.step.do === 'world' && Object.values(s.before.nodes).some((n) => Object.values(n.links ?? {}).some((l) => l.length > 0)));
  assert.ok(quiet.length >= 1);
  for (const s of quiet) assert.equal(s.result.verdict, 'no');
});

test('each role need has its rule for leaving, and the talk uses only the closed lists', () => {
  const entry = kinds['test:talk'] as Activity;
  assert.deepEqual(new Set(Object.values(entry.roles!).map((r) => r.need)), new Set(ROLE_NEEDS));
  assert.deepEqual(Object.keys(entry.now!).filter((k) => !NOW_PARTS.includes(k)), []);
  const outcome = (need: string) => all().filter((s) => s.step.do === 'leave' && s.result.verdict === 'yes' && entry.roles![s.result.role as string].need === need && Object.values(s.after.nodes).some((n) => n.kind === 'test:talk'));
  assert.ok(outcome('replaceable').length >= 1, 'a replaceable role leaving leaves the talk running');
  assert.ok(outcome('optional').length >= 1, 'an optional role leaving leaves the talk running');
  assert.equal(outcome('required').length, 0, 'a required role leaving never leaves it running');
});

test('the now line leaves out what the asker may not see and never throws', () => {
  const state = { nodes: { t1: { kind: 'test:talk', links: { speaker: ['b1'] } } } };
  const hidden = structuredClone(kinds);
  (hidden['test:talk'] as Activity).links!.speaker.audience = 'members';
  const r = nowLine({ kinds: hidden, state, node: 't1', asker: { sees: ['public'] } });
  assert.equal(r.verdict, 'yes');
  if (r.verdict === 'yes') {
    assert.deepEqual(r.unseen, ['floor']);
    assert.equal(r.now.floor, undefined);
    assert.equal(r.now.stage, 'proposed');
  }
  for (const bad of [null, {}, { kinds, state, node: 'nope', asker: { sees: 'all' } }, { kinds, state: { nodes: { t1: { kind: 'eden:bench' } } }, node: 't1', asker: { sees: 'all' } }]) {
    assert.equal(nowLine(bad as never).verdict, 'no');
  }
});

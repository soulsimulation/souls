// Between two Souls: give, hug, handshake, high five, dance, push the swing (Soul Actions SA-G4, #2876). The cases in
// cases/activity/pairs/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { enter, lapse, leave, nowLine, type Activity } from './activity.ts';
import { apply, effects, parentOf, type State } from './effects.ts';
import { CASES, loadKinds, mismatches, ROOT, same } from './load.ts';
import { accept, pairOf, PAIR_PARTS, type Move, type Pair } from './pairs.ts';
import type { Input, Int } from './rules.ts';

type Step = { do: 'offer' | 'accept' | 'leave' | 'world' | 'now'; actor?: string; form?: string; receipt?: string; now_us?: number; expect: Record<string, unknown> };
type StepCase = { name: string; activity: string; state: { nodes: Input['state']['nodes'] }; steps: Step[]; after?: Record<string, unknown>; gone?: string[] };

const kinds = loadKinds();
const moves: Record<string, Move> = {};
for (const f of readdirSync(join(ROOT, 'content/moves')).filter((f) => f.endsWith('.json'))) {
  const m = JSON.parse(readFileSync(join(ROOT, 'content/moves', f), 'utf8'));
  moves[m.move] = m;
}
const PAIRS = ['test:give', 'test:hug', 'test:handshake', 'test:high_five', 'test:dance', 'test:push_swing'];
const DIR = join(CASES, 'activity', 'pairs');
const cases: [string, StepCase][] = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  assert.equal(doc.format, 'souls-activity-steps/1', file);
  for (const c of doc.cases) cases.push([file, c]);
}

type Seen = { step: Step; result: Record<string, unknown>; before: State; after: State };
const runs = new Map<string, Seen[]>();
const isBody = (nodes: State['nodes'], id: string) => !!nodes[id] && !nodes[id].kind && 'hands' in nodes[id];
const members = (nodes: State['nodes'], id: string) => {
  const n = nodes[id];
  const roles = n?.kind ? Object.keys((kinds[n.kind] as Activity).roles ?? {}) : [];
  return new Set(roles.flatMap((r) => (n.links?.[r] ?? []) as string[]));
};

/** One step, as the engine would run it: a Soul's act, the world's timer, or a read of the now line. */
function run(c: { activity: string }, state: State, step: Step): Record<string, unknown> {
  const act = { this: c.activity, form: step.form ?? '' };
  const as = { ...state, actor: step.actor ?? '', now_us: step.now_us };
  const asker = { sees: ['public'] };
  if (step.do === 'now') return nowLine({ kinds, state, node: c.activity, asker });
  if (step.do === 'offer') return enter({ kinds, act, state: as, asker, receipt: step.receipt! });
  if (step.do === 'accept') return accept({ kinds, act, state: as, asker, receipt: step.receipt! });
  if (step.do === 'leave') return leave({ kinds, act, state: as, asker, receipt: step.receipt! });
  return lapse({ kinds, act, state: as, receipt: step.receipt! });
}

for (const [file, c] of cases) {
  test(`activity/pairs/${file}: ${c.name}`, () => {
    let state: State = structuredClone({ actor: '', ...c.state });
    const seen: Seen[] = [];
    c.steps.forEach((step, k) => {
      const result = run(c, state, step);
      assert.deepEqual(mismatches(step.expect, result), [], `step ${k}: ${JSON.stringify(result)}`);
      const before = state;
      if (step.do !== 'now' && result.verdict === 'yes') {
        const done = apply(state, result as Parameters<typeof apply>[1]);
        if (!done.ok) return assert.fail(`step ${k}: ${JSON.stringify(done)}`);
        state = { ...done.state, actor: '' };
      }
      // Nothing is done to a Soul that did not join: a change names a body only if it is the actor or a member.
      const joined = members(before.nodes, c.activity);
      for (const ch of (result.changes ?? []) as { node: string; end?: string }[]) {
        for (const id of [ch.node, ch.end]) if (id && isBody(before.nodes, id)) assert.ok(id === step.actor || joined.has(id), `step ${k}: ${id} did not join`);
      }
      // No step removes a body.
      for (const id of Object.keys(before.nodes).filter((id) => isBody(before.nodes, id))) assert.ok(parentOf(state.nodes, id), `step ${k}: body ${id} is nowhere`);
      seen.push({ step, result, before, after: state });
    });
    for (const [id, want] of Object.entries(c.after ?? {})) assert.ok(same(state.nodes[id] ?? null, want), `${id}: ${JSON.stringify(state.nodes[id] ?? null)}`);
    for (const id of c.gone ?? []) assert.equal(state.nodes[id], undefined, `${id} is removed`);
    runs.set(c.name, seen);
  });
}

const events = (s: Seen) => ((s.result.events ?? []) as { event: string }[]).map((e) => e.event);

test('A1: a book offered and accepted ends in the other\'s hand, in the batch that joins the taker', () => {
  const seen = runs.get('a_book_offered_and_accepted_ends_in_the_others_hand')!;
  const yes = seen.find((s) => s.step.do === 'accept')!;
  assert.equal(parentOf(yes.before.nodes, 'book1')?.node, 'b1');
  assert.deepEqual(parentOf(yes.after.nodes, 'book1'), { node: 'b2', hand: 'left' });
  assert.deepEqual(events(yes), ['test:joined', 'test:took_place', 'test:handed_over', 'test:began']);
  // Both sides or neither: a refused accept changes nothing, and the book stays with the giver.
  for (const name of ['the_taker_has_no_free_hand_so_nothing_changes', 'the_giver_no_longer_holds_it_so_nothing_changes']) {
    const no = runs.get(name)!.find((s) => s.step.do === 'accept')!;
    assert.equal(no.result.verdict, 'no');
    assert.deepEqual(no.after, no.before);
  }
});

test('A1: a book offered and not accepted in time stays with the giver, and the giver is told', () => {
  const seen = runs.get('a_book_offered_and_not_accepted_in_time_stays_and_the_asker_is_told')!;
  const ends = BigInt((seen.find((s) => s.step.do === 'now')!.result as { now: { ends_us: Int } }).now.ends_us);
  const late = seen.find((s) => s.step.do === 'accept')!;
  assert.equal(BigInt(late.step.now_us!), ends, 'an accept at the stated end is too late');
  assert.equal(late.result.verdict, 'no');
  const lapsed = seen.find((s) => s.step.do === 'world' && s.result.verdict === 'yes')!;
  assert.equal(BigInt(lapsed.step.now_us!), ends);
  assert.ok(seen.some((s) => s.step.do === 'world' && BigInt(s.step.now_us!) === ends - 1n && s.result.verdict === 'no'), 'not a microsecond before');
  assert.deepEqual(events(lapsed), ['test:released', 'test:offer_lapsed']);
  // Told: the released event unlinks the giver from its role, by name.
  const changes = lapsed.result.changes as { change: string; link?: string; end?: string }[];
  const released = (lapsed.result.events as { event: string; changes: number[] }[])[0];
  assert.ok(released.changes.some((i) => changes[i].change === 'unlink' && changes[i].link === 'giver' && changes[i].end === 'b1'));
  assert.deepEqual(parentOf(lapsed.after.nodes, 'book1'), { node: 'b1', hand: 'right' });
  assert.deepEqual(parentOf(lapsed.after.nodes, 'b1'), { node: 'r1' });
});

test('A2: each of the six validates as an activity of two with an expiry, and runs offer, accept and lapse', () => {
  for (const kind of PAIRS) {
    const entry = kinds[kind] as Activity;
    const pair = pairOf(entry, moves);
    assert.ok(!('bad' in pair), `${kind}: ${JSON.stringify(pair)}`);
    assert.deepEqual(Object.keys((entry as { pair?: object }).pair!).filter((k) => !PAIR_PARTS.includes(k)), []);
    // Accepted in its case, by the invited Soul; then the same offer, never accepted, lapses at the microsecond its
    // now line states and not one before.
    const [c, seen] = cases.map(([, x]) => [x, runs.get(x.name)!] as const).find(([x]) => x.state.nodes[x.activity].kind === kind)!;
    assert.ok(seen.some((s) => s.step.do === 'accept' && s.result.verdict === 'yes'), `${kind} accepted in a case`);
    const first = seen[0];
    let state = structuredClone(first.before);
    const offered = run(c, state, c.steps[0]);
    assert.equal(offered.verdict, 'yes', kind);
    const done = apply(state, offered as Parameters<typeof apply>[1]);
    assert.ok(done.ok);
    state = { ...done.state, actor: '' };
    const ends = Number((run(c, state, { do: 'now', expect: {} }) as { now: { ends_us: Int } }).now.ends_us);
    assert.equal(run(c, state, { do: 'world', actor: 'w', form: (pair as Pair).expires, receipt: 'w0', now_us: ends - 1, expect: {} }).verdict, 'no', kind);
    const gone = run(c, state, { do: 'world', actor: 'w', form: (pair as Pair).expires, receipt: 'w1', now_us: ends, expect: {} });
    assert.equal(gone.verdict, 'yes', kind);
    assert.equal(events({ result: gone } as Seen).at(-1), 'test:offer_lapsed');
  }
});

test('A2: what is not a pair with an expiry is refused by name', () => {
  const broken: [string, (e: Record<string, any>) => void, string][] = [
    ['test:hug', (e) => delete e.forms.lapse, 'no_expiry'],
    ['test:hug', (e) => (e.forms.accept.who = 'anyone'), 'accept_not_by_the_invited'],
    ['test:hug', (e) => (e.forms.accept.needs = e.forms.accept.needs.filter((n: { need: string; field?: string }) => n.field !== 'left_us')), 'accept_not_in_time'],
    ['test:hug', (e) => (e.forms.accept.needs = e.forms.accept.needs.filter((n: { need: string }) => n.need !== 'linked')), 'accept_before_the_asker'],
    ['test:hug', (e) => (e.forms.lapse.needs = e.forms.lapse.needs.filter((n: { need: string }) => n.need !== 'unlinked')), 'expiry_after_accepting'],
    ['test:hug', (e) => (e.roles.partner.need = 'optional'), 'not_two_required_roles'],
    ['test:hug', (e) => (e.forms.offer.who = 'anyone'), 'no_offering_form'],
    ['test:hug', (e) => delete e.forms.step_away, 'no_leaving_form'],
    ['test:hug', (e) => (e.state.left_us.default.per_s = 0), 'no_countdown'],
    ['test:hug', (e) => (e.pair.contact[0].move = 'grab'), 'malformed_contact'],
    ['test:hug', (e) => (e.pair.contact[0].beat = 0), 'malformed_contact'],
    ['test:hug', (e) => (e.pair.extra = 1), 'malformed_pair'],
    // Nothing moves a body by a link: a form that reparents the partner, or a give into anything but the accepter's hand.
    ['test:hug', (e) => e.forms.offer.effects.push({ change: 'reparent', what: { link: 'partner' }, into: 'here', event: 'test:pulled' }), 'moves_what_it_may_not'],
    ['test:give', (e) => (e.forms.accept.effects[2].into = 'here'), 'moves_what_it_may_not'],
  ];
  for (const [kind, mutate, bad] of broken) {
    const e = structuredClone(kinds[kind]) as Record<string, any>;
    mutate(e);
    const r = pairOf(e as Activity, moves);
    assert.equal('bad' in r ? r.bad : 'valid', bad, `${kind}: ${bad}`);
  }
  assert.equal((pairOf(kinds['test:talk'] as Activity, moves) as { bad: string }).bad, 'not_a_pair');
});

test('A3: a handshake states its two contact points and its beat as data', () => {
  const pair = pairOf(kinds['test:handshake'] as Activity, moves) as Pair;
  assert.equal(pair.contact.length, 2);
  const [a, b] = [pair.asker, pair.partner].map((role) => pair.contact.find((c) => c.role === role)!);
  for (const c of [a, b]) {
    assert.ok(moves[c.move], `a move from content/moves: ${c.move}`);
    assert.ok(c.contact_mm.every(Number.isSafeInteger), 'whole millimetres in the activity\'s own frame');
  }
  assert.equal(a.beat, b.beat, 'both hands land on one beat');
  assert.ok(Number.isSafeInteger(pair.beat_us) && pair.beat_us > 0, 'a beat is whole microseconds');
  // The palms meet: the two points are within B8's 2 cm.
  const d2 = a.contact_mm.reduce((s, v, i) => s + (v - b.contact_mm[i]) ** 2, 0);
  assert.ok(d2 <= 20 * 20, `${Math.sqrt(d2)} mm apart`);
});

test('a give moves only the thing it offers, never a body', () => {
  const state: State = {
    actor: 'b2',
    nodes: {
      r1: { loose: ['g1', 'b1', 'b2'] },
      g1: { kind: 'test:give', at_mm: [0, 0, 0], links: { invited: ['b2'], proposer: ['b1'], offered: ['b1'], giver: ['b1'] }, slots: { giver: ['b1'] }, fields: { left_us: { value: 30000000, per_s: -1000000, set_us: 0 } } },
      b1: { hands: { left: null, right: null } },
      b2: { hands: { left: null, right: null } },
    },
    now_us: 1000000,
  };
  const r = effects({ kinds, act: { this: 'g1', form: 'accept', args: { place: { node: 'g1', slot: 'taker' } } }, state, receipt: 'z' });
  assert.equal(r.verdict, 'no');
  assert.deepEqual((r as { detail: unknown }).detail, { what: 'malformed_subject' });
});

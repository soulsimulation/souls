import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Bridge, entityOf } from './bridge.ts';
import { defaultLookOf, entityWithLook } from './take-bodies.ts';
import { chunkOf, TICK_US, type Body } from './takes.ts';
import { consumeAt, endConsumes, recordConsume } from './take-gestures.ts';
import { setKindFields } from './world-state.ts';
import type { MoveRec } from './source/source.ts';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { TakePeople } from '../../../../mars/viewer/app/engine-view/take-replay.ts';
import type { HumanViews, SampledHuman } from '../../../../mars/viewer/app/engine-view/humans.ts';
import { recordedConsumeMove } from '../../../../mars/viewer/app/engine-view/held-entry.ts';

const T0 = 10_000_000, Q = 2 ** 30;
const node = (id: string, kind: string, parent: string | null, extra: object = {}) => ({ id, kind, parent, slot: null,
  pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null, ...extra });
const world = node('world', 'souls:place@1', null);
const diner = node('diner', 'souls:body@1', 'world', { soul: 'diner-soul', at: T0 });
const partner = node('partner', 'souls:body@1', 'world', { soul: 'partner-soul', at: T0, pos: [1_000_000, 0, 0] });
const bowl = node('bowl', 'eden:soup_bowl@abcd', 'diner', { slot: 7, fields: { 28: 2 } });
const entity = entityWithLook(entityOf('diner'), defaultLookOf('diner'));
const move = (): MoveRec => ({ body: 'diner', name: 'souls:consume@1', run: 'meal-run', target: 'bowl',
  limbs: ['souls:hand-left', 'souls:voice'], contact: 'bite', start: T0 + 200_000,
  ends: [T0 + 800_000, T0 + 1_800_000, T0 + 2_400_000] });
const part = (number: number, extra: object = {}) => ({ t: 'part' as const, p: { number, from: T0 + number * 500_000,
  to: T0 + (number + 1) * 500_000, nodes: [], removed: [], samples: [], ...extra } as never });
const takeAt = (bridge: V2Bridge, seconds: number): Take => {
  const tick = T0 / TICK_US + seconds / .05;
  const chunk = bridge.view.takes.chunks.find(c => c.fromTick <= tick && tick < c.toTick);
  assert(chunk); return JSON.parse(JSON.stringify(chunk.take)) as Take;
};
const at = (take: Take, seconds: number) => sampleTake(take, T0 / 1_000_000 + seconds - take.startTick * take.dt).entities[entity];

test('real bridge→chunk→sample→people preserves consume facts and independent owners through late cuts and seeks', () => {
  setKindFields({ 'eden:soup_bowl': { soup: [28, 'int', 0] } });
  const bridge = new V2Bridge({ rulesVersion: 'consume-test' }), control = new V2Bridge({ rulesVersion: 'consume-test' });
  const input = move();
  const press: MoveRec = { body: 'diner', name: 'souls:press', start: T0, ends: [T0 + 600_000, T0 + 2_500_000], target: 'bowl', limbs: ['souls:hand-right'], run: 'press-run' };
  const paired: MoveRec = { body: 'diner', name: 'souls:hold_hand', start: T0 + 3_000_000, ends: [T0 + 9_000_000], target: 'partner', run: 'pair-run' };
  try {
    for (const b of [bridge, control]) b.receive({ t: 'snapshot', s: { nodes: [world, diner, partner, bowl], removed: [] } as never });
    bridge.receive(part(0, { moves: [press, input, paired] }));
    control.receive(part(0, { moves: [press, paired] }));
    input.ends[0] = T0 + 999_999; input.limbs![0] = 'mutated';
    for (let n = 1; n < 12; n++) for (const b of [bridge, control]) b.receive(part(n, n === 1 || n === 2 ? { nodes: [{ ...bowl, fields: { 28: n === 1 ? 1 : 0 } }] } : {}));
    const published = bridge.view.takes.chunks.find(c => c.fromTick === T0 / TICK_US)!;
    const oldTake = takeAt(bridge, .25), oldJSON = JSON.stringify(published.take);
    const expected = move();
    assert.deepEqual(at(oldTake, .25).state.consumeMove, expected);
    for (const seconds of [.25, .75, 1.25, 3.25]) {
      const actual = at(takeAt(bridge, seconds), seconds), unchanged = at(takeAt(control, seconds), seconds);
      const { consumeMove: ignored, ...state } = actual.state;
      assert.deepEqual(state, unchanged.state, 'consume must not replace press, paired, seat, prop or activity state');
      assert.deepEqual(actual.p, unchanged.p); assert.equal(actual.yaw, unchanged.yaw); assert.equal(actual.activity, unchanged.activity);
    }
    assert.equal((at(takeAt(bridge, 1.25), 1.25).state.heldEntries as { entries: { state: { soup: number } }[] }).entries[0].state.soup, 1);
    assert.equal((at(takeAt(bridge, 1.75), 1.75).state.heldEntries as { entries: { state: { soup: number } }[] }).entries[0].state.soup, 0);
    const ended = { at: T0 + 1_100_000, how: 'interrupted' };
    // This arrives after the first take was published. Only newly built snapshots acquire the ending.
    bridge.receive(part(12, { moves: [{ ...move(), ended }], runEnds: [{ body: 'diner', run: 'meal-run', at: T0 + 1_300_000, how: 'cancelled' }] }));
    for (let n = 13; n < 20; n++) bridge.receive(part(n));
    assert.equal(JSON.stringify(published.take), oldJSON, 'the actual earlier published object is unchanged');
    assert.equal(at(takeAt(bridge, .25), .25).state.consumeMove && (at(takeAt(bridge, .25), .25).state.consumeMove as { ended?: unknown }).ended, undefined);
    const latest = takeAt(bridge, 7.25), record = recordedConsumeMove(at(latest, 7.25).state.consumeMove)!;
    assert.deepEqual(record, { ...move(), ended, runEnd: { at: T0 + 1_300_000, how: 'cancelled' } });
    assert(Object.isFrozen(record)); assert(Object.isFrozen(record.ends)); assert(Object.isFrozen(record.limbs)); assert(Object.isFrozen(record.ended));
    const people = new TakePeople(oldTake), views = (people as unknown as { humans: HumanViews }).humans;
    let frames: SampledHuman[] = []; views.setFrame = f => { frames = f; };
    try {
      const show = (take: Take, seconds: number) => {
        people.setTake(take); people.show(T0 / 1_000_000 + seconds - take.startTick * take.dt, 9000);
        return frames.find(f => f.id === entity)!;
      };
      assert.deepEqual(show(oldTake, .25).consumeMove, expected);
      assert.deepEqual(show(latest, 7.25).consumeMove, record);
      assert.deepEqual(show(oldTake, .25).consumeMove, expected, 'backward seek restores the old immutable observation');
      const legacy = structuredClone(oldTake); legacy.changes = legacy.changes.filter(c => c[2] !== 'consumeMove');
      assert.equal(show(legacy, .25).consumeMove, undefined);
    } finally { people.dispose(); }
  } finally { setKindFields({}); }
});

test('immutable histories preserve missing facts, separate endings, last begun state and seat/root/press authority', () => {
  const original = move(), history = recordConsume(undefined, original), retained = history[0];
  assert.equal(consumeAt(history, T0), undefined);
  assert.equal(consumeAt(history, T0 + 20_000_000), retained, 'last record is not a fabricated active interval');
  assert.equal(endConsumes(history, { at: T0 + 900_000, run: 'another-run', how: 'done' })![0], retained);
  const cut = endConsumes(history, { at: T0 + 900_000, run: original.run })!;
  assert.deepEqual(cut[0].runEnd, { at: T0 + 900_000 }); assert.equal(retained.runEnd, undefined);
  const late = recordConsume(cut, { ...move(), ended: { at: T0 + 700_000, how: 'released' } });
  assert.deepEqual(late[0].runEnd, cut[0].runEnd); assert.equal(late[0].ended?.how, 'released');
  assert.equal(recordConsume(late, move())[0].ended?.how, 'released', 'a duplicate start does not erase known endings');
  const missing = move(); delete missing.limbs; delete missing.contact; delete missing.run;
  assert.deepEqual(Object.keys(recordConsume(undefined, missing)[0]).sort(), Object.keys(missing).sort());
  assert.deepEqual(recordedConsumeMove({ ...missing, ends: [missing.start, missing.start, missing.start + 1] })?.ends,
    [missing.start, missing.start, missing.start + 1], 'zero-duration native phases are retained');
  assert.equal(recordedConsumeMove({ ...missing, ends: [missing.start - 1] }), undefined);
  assert.equal(recordedConsumeMove({ ...missing, ended: { at: missing.start - 1, how: 'bad' } }), undefined);
  const body: Body = { entity: 'person', soul: 'soul', name: 'Person', heading: .2,
    samples: [{ at: T0, p: [1200, 0, -500], seat: { height: 470, lie: false } }],
    gestures: [{ start: T0, end: T0 + 9_000_000, activity: 'operate', press: { hand: 'right', start: T0, contact: T0 + 500_000, end: T0 + 9_000_000 } }] };
  const plain = chunkOf([body], T0 / TICK_US, { rulesVersion: 'consume-test', datetime: null }).take as unknown as Take;
  const withConsume = chunkOf([{ ...body, consumes: late }], T0 / TICK_US, { rulesVersion: 'consume-test', datetime: null }).take as unknown as Take;
  const a = sampleTake(plain, .5).entities.person, b = sampleTake(withConsume, .5).entities.person;
  const { consumeMove: ignored, ...state } = b.state;
  assert.deepEqual(state, a.state); assert.deepEqual(b.p, a.p); assert.equal(b.activity, a.activity);
  assert.equal(b.state.baseActivity, 'sit'); assert(b.state.formPress);
});

test('bridge trims old consume history while retaining the last observation before the seek window', () => {
  const bridge = new V2Bridge({ rulesVersion: 'consume-test' });
  bridge.receive({ t: 'snapshot', s: { nodes: [world, diner], removed: [] } as never });
  const first = move(), last = { ...move(), run: 'later-run', start: T0 + 1_200_000,
    ends: [T0 + 1_500_000, T0 + 2_000_000, T0 + 2_500_000] };
  bridge.receive(part(0, { moves: [first, last] }));
  for (let n = 1; n < 200; n++) bridge.receive(part(n));
  assert.deepEqual(at(takeAt(bridge, 96.25), 96.25).state.consumeMove, last,
    'a completed consume remains observable after its original chunks/history have expired');
});

test('a run ending without its native run identity cannot claim any prior consume', () => {
  const previous = { ...move(), run: 'previous-run', ended: { at: T0 + 300_000, how: 'released' } };
  const current = { ...move(), run: 'current-run', start: T0 + 400_000 };
  const unknown = move(); delete unknown.run;
  const history = recordConsume(recordConsume(recordConsume(undefined, previous), current), unknown);
  const result = endConsumes(history, { at: T0 + 900_000, how: 'done' })!;
  assert.deepEqual(result, history);
  for (let i = 0; i < history.length; i++) {
    assert.equal(result[i], history[i]); assert.equal(result[i].runEnd, undefined);
  }
  assert.deepEqual(result.find(c => c.run === previous.run)?.ended, previous.ended, 'a known move ending is not a guessed run ending');
});

test('bridge preserves the first matching run termination against later duplicate and unrelated events', () => {
  const bridge = new V2Bridge({ rulesVersion: 'consume-test' });
  bridge.receive({ t: 'snapshot', s: { nodes: [world, diner], removed: [] } as never });
  bridge.receive(part(0, { moves: [move()] }));
  bridge.receive(part(1, { runEnds: [{ body: 'diner', at: T0 + 800_000, how: 'unknown-run' }] }));
  bridge.receive(part(2, { runEnds: [{ body: 'diner', run: 'meal-run', at: T0 + 1_100_000, how: 'cancelled' }] }));
  bridge.receive(part(3, { runEnds: [{ body: 'diner', run: 'meal-run', at: T0 + 1_700_000, how: 'later-terminal' },
    { body: 'diner', run: 'different-run', at: T0 + 1_800_000, how: 'done' }] }));
  for (let n = 4; n < 16; n++) bridge.receive(part(n));
  const record = recordedConsumeMove(at(takeAt(bridge, 5.25), 5.25).state.consumeMove)!;
  assert.deepEqual(record.runEnd, { at: T0 + 1_100_000, how: 'cancelled' });
  assert.equal(record.ended, undefined, 'form termination never creates a native move ending');
});

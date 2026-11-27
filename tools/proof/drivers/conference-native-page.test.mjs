import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { conferenceFixtures, conferenceJourney, conferenceFinalization, conferenceBrowserStop, conferenceMeetingStage, conferenceMeetingJourney } from './conference-native-page.mjs';
import { explainConference, rehearsalTemplate } from '../../playtest/conference/rehearse.mjs';

test('tracked conference fixture preserves the existing authored layout exactly', () => {
  const eden = JSON.parse(readFileSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)));
  const scene = JSON.parse(readFileSync(new URL('../../../worlds/templates/conference-rehearsal.json', import.meta.url)));
  assert.deepEqual(scene, rehearsalTemplate(eden));
});

test('ambiguous discovery refuses instead of choosing an unrelated lectern', () => {
  const question = { id: 'question' }, benchA = { id: 'left', name: 'audience-left' }, benchB = { id: 'right', name: 'audience-right' };
  const seen = { lecterns: [{ id: 'lectern' }], questions: [question], benches: [benchB, benchA] };
  assert.deepEqual(conferenceFixtures(seen), { lecture: 'lectern', question: 'question', benches: ['left', 'right'] });
  assert.throws(() => conferenceFixtures({ ...seen, lecterns: [...seen.lecterns, { id: 'unrelated' }] }), /one authored presentation lectern/);
  assert.throws(() => conferenceFixtures({ ...seen, benches: [benchA] }), /two authored audience benches/);
});

for (const outcome of [{ answer: 'receipt' }, { answer: 'refused', reason: 'out_of_reach' }]) {
  test(`unrelated terminal ${outcome.reason ?? outcome.answer} is not an interruption`, async () => {
    const calls = []; let polls = 0;
    const done = { ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } };
    const speaker = { label: 'Presenter', body: 'body', cli: async (...words) => {
      calls.push(words);
      if (words[0] === 'inspect') return { ok: true, parent: 'lectern' };
      if (words[0] === 'act' && words[1] === 'tell_story' && !words.includes('--wait')) return { ok: true, sequence: 7 };
      if (words[0] === 'receipt') return { ok: true, receipt: { going: ++polls === 1, answers: [polls === 1 ? { answer: 'accepted', at: 123 } : outcome] } };
      return done;
    } };
    await assert.rejects(explainConference({ speaker, lecture: 'lectern', question: 'question', interruptStory: true }), /native refused:left/);
    assert(calls.some(([op, word]) => op === 'act' && word === 'point'));
    assert(!calls.some(([op, word]) => op === 'act' && word === 'clap'));
  });
}

test('an admission refusal cannot masquerade as an observed story start', async () => {
  const calls = [];
  const speaker = { label: 'Presenter', body: 'body', cli: async (...words) => {
    calls.push(words);
    if (words[0] === 'inspect') return { ok: true, parent: 'lectern' };
    if (words[0] === 'receipt') return { ok: true, receipt: { going: false, answers: [{ answer: 'refused', reason: 'out_of_reach' }] } };
    if (!words.includes('--wait')) return { ok: true, sequence: 7 };
    return { ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } };
  } };
  await assert.rejects(explainConference({ speaker, lecture: 'lectern', question: 'question', interruptStory: true }), /still be running/);
  assert(!calls.some(([op, word]) => op === 'act' && word === 'point'));
});

test('receipt-only, stale and missing presenter diagnostics cannot qualify a depicted journey', () => {
  const sample = (tick, activity) => ({ tick, dt: .05, renderFrame: tick, souls: [{ id: 'soul', entityId: 'entity' }],
    residents: [{ id: 'soul', body: 'entity', activity }], entities: { entity: {} } });
  assert.throws(() => conferenceJourney([], 'soul'), /samples missing/);
  assert.throws(() => conferenceJourney([sample(1, 'tell-story'), sample(1, 'point')], 'soul'), /clock stale/);
  assert.throws(() => conferenceJourney([{ ...sample(1, 'tell-story'), souls: [] }, sample(2, 'point')], 'soul'), /mapping missing/);
  assert.throws(() => conferenceJourney([sample(1, 'tell-story'), sample(2, 'point'), sample(3, 'clap'), sample(4, 'idle')], 'soul'), /phases not all depicted/);
  const phases = [1, 90, 180, 260].map(t => sample(t, 'tell-story'));
  const valid = [...phases, sample(300, 'point'), sample(320, 'clap'), sample(340, 'idle'), sample(341, 'idle')];
  assert.equal(conferenceJourney(valid, 'soul').phases.length, 3);
  assert.throws(() => conferenceJourney(valid.slice(0, -2), 'soul'), /settled endpoint/);
});

test('render-observer collection is idempotent and a collection error cannot discard action receipts', async () => {
  const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
  const paths = { dir: mkdtempSync(join(scratch, 'conference-finalize-test-')) };
  const state = { rows: [{ words: ['receipt', '7'], answer: { receipt: { answers: [{ answer: 'refused', reason: 'left' }] } } }] };
  let calls = 0;
  conferenceFinalization({ evaluate: async () => {
    calls++;
    assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'command-conference-sequence.json'))).rows, state.rows, 'receipts were saved before risky collection');
    throw Error('lost browser context');
  } }, paths, state);
  const first = state.finalizeDraw(), again = state.finalizeDraw();
  assert.equal(first, again, 'rejection is cached, not retried');
  await assert.rejects(first, /lost browser context/);
  await assert.rejects(again, /lost browser context/);
  await assert.rejects(state.finalizeDraw(), /lost browser context/);
  state.finalizationError = 'lost browser context'; state.persistSequence(); state.persistSequence();
  assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'command-conference-sequence.json'))).rows, state.rows);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(paths.dir, 'command-conference-finalization.json'))).ok, false);
  const goodPaths = { dir: mkdtempSync(join(scratch, 'conference-finalize-test-')) }, good = {};
  conferenceFinalization({ evaluate: async () => { calls++; return { samples: [{ frame: 1 }, { frame: 2 }], failures: [] }; } }, goodPaths, good);
  await good.finalizeDraw(); await good.finalizeDraw();
  assert.equal(calls, 2, 'restored observer is collected once');
  assert.equal(JSON.parse(readFileSync(join(goodPaths.dir, 'command-conference-final-draw.json'))).samples.length, 2);
});

test('the exact serialized browser stop restores hooks once and caches both result and ownership error', () => {
  const previous = globalThis.window; let stops = 0;
  const show = () => {}, original = () => {}, prototype = { show };
  const fixture = () => ({ samples: [{ frame: 1 }, { frame: 2 }], failures: [], sampleLimit: 361,
    stopRender() { stops++; }, prototype, show, original, qualification: 'test' });
  try {
    globalThis.window = { __conferenceDrawObserver: fixture() };
    const first = conferenceBrowserStop();
    assert.equal(conferenceBrowserStop(), first); assert.equal(prototype.show, original); assert.equal(stops, 1);
    prototype.show = () => {};
    globalThis.window.__conferenceDrawObserver = fixture();
    let failure;
    try { conferenceBrowserStop(); } catch (error) { failure = error; }
    assert.match(failure.message, /ownership changed/);
    assert.throws(conferenceBrowserStop, error => error === failure);
    assert.equal(stops, 2, 'failed browser cleanup is also never repeated');
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('an installed observer cannot disappear between the journey check and final collection', async () => {
  const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
  const paths = { dir: mkdtempSync(join(scratch, 'conference-finalize-test-')) }, state = { observerInstalled: true, rows: [] };
  conferenceFinalization({ evaluate: async () => undefined }, paths, state);
  await assert.rejects(state.finalizeDraw(), /installed observer collection missing/);
  assert.equal(JSON.parse(readFileSync(join(paths.dir, 'command-conference-finalization.json'))).ok, false);
});

const meetingFrame = (tick, activity = 'idle', seated = false) => ({ tick, dt: .05, renderFrame: tick,
  souls: [{ id: 'soul', entityId: 'entity' }], residents: [{ id: 'soul', body: 'entity', activity, activityAge: .3 }],
  entities: { entity: { state: seated ? { baseActivity: 'sit', seatHeight: .465 } : {} } } });
const phase = (stage, start, frames) => {
  const stages = [{ stage: start, soul: 'soul', frameIndex: 0 }, { stage, soul: 'soul', frameIndex: frames.length - 1 }];
  return conferenceMeetingStage(frames, stages, stages[1]);
};

test('audience entry requires an observed standing-to-seat change, not only a terminal seat', () => {
  assert.doesNotThrow(() => phase('attend-done', 'attend-start', [meetingFrame(1), meetingFrame(2, 'walk'), meetingFrame(3, 'sit', true)]));
  assert.throws(() => phase('attend-done', 'attend-start', [meetingFrame(1, 'sit', true), meetingFrame(2, 'sit', true)]), /sit entry not depicted/);
  assert.throws(() => phase('attend-done', 'attend-start', [meetingFrame(1), meetingFrame(1, 'sit', true)]), /clock stale/);
});

test('a seated wave must preserve its underlying seat and visibly return to sitting', () => {
  const frames = [meetingFrame(1, 'sit', true), meetingFrame(2, 'wave', true), meetingFrame(3, 'sit', true), meetingFrame(4, 'sit', true)];
  assert.doesNotThrow(() => phase('seated-wave-done', 'seated-wave-start', frames));
  assert.throws(() => phase('seated-wave-done', 'seated-wave-start', frames.slice(0, -1)), /return not depicted/);
  assert.throws(() => phase('seated-wave-done', 'seated-wave-start', frames.map(f => f.tick === 2 ? meetingFrame(2, 'wave') : f)), /lost underlying seat/);
  assert.throws(() => phase('seated-wave-done', 'seated-wave-start', [...frames.slice(0, 2), meetingFrame(3), meetingFrame(4)]), /return seated/);
});

test('rise and question gates require actual depicted standing and the next ordinary action', () => {
  assert.doesNotThrow(() => phase('rise-done', 'rise-start', [meetingFrame(1, 'sit', true), meetingFrame(2), meetingFrame(3)]));
  assert.throws(() => phase('rise-done', 'rise-start', [meetingFrame(1), meetingFrame(2)]), /rise from seat/);
  assert.doesNotThrow(() => phase('question-posted', 'question-start', [meetingFrame(1), meetingFrame(2, 'operate')]));
  assert.throws(() => phase('question-posted', 'question-start', [meetingFrame(1), meetingFrame(2, 'sit', true)]), /question action not depicted/);
});

test('meeting gate rejects a short journey and incomplete assembly observations', () => {
  assert.throws(() => conferenceMeetingJourney([], [], Array(5).fill({})), /stage coverage incomplete/);
  const counts = { 'attend-done': 8, 'lectern-ready': 2, 'lecture-ready': 2, 'story-complete': 2,
    'seated-wave-done': 1, 'rise-done': 8, point: 2, settled: 2, 'question-posted': 1,
    'question-refused': 1, 'question-recovered': 1, 'introduction-done': 1, 'conference-clean': 1 };
  const stages = Object.entries(counts).flatMap(([stage, count]) => Array.from({ length: count }, () => ({ stage })));
  assert.throws(() => conferenceMeetingJourney([meetingFrame(1), meetingFrame(2)], stages, Array(5).fill({})), /assemblies must be captured/);
});

test('group cleanup rejects a departed actor still seated or a group never seen applauding', () => {
  const stages = [{ stage: 'applause-start', soul: 'soul', frameIndex: 0 }, { stage: 'conference-clean', soul: 'soul', seats: ['soul'], frameIndex: 3 }];
  const frames = [meetingFrame(1, 'clap'), meetingFrame(2, 'clap'), meetingFrame(3), meetingFrame(4)];
  assert.doesNotThrow(() => conferenceMeetingStage(frames, stages, stages[1]));
  assert.throws(() => conferenceMeetingStage([...frames.slice(0, -1), meetingFrame(4, 'sit', true)], stages, stages[1]), /standing rest/);
  assert.throws(() => conferenceMeetingStage(frames.map(f => meetingFrame(f.tick)), stages, stages[1]), /applause not depicted/);
});

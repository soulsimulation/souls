import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { conferenceFixtures, conferenceJourney, conferenceFinalization } from './conference-native-page.mjs';
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
    assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'conference-sequence.json'))).rows, state.rows, 'receipts were saved before risky collection');
    throw Error('lost browser context');
  } }, paths, state);
  const first = state.finalizeDraw(), again = state.finalizeDraw();
  assert.equal(first, again, 'rejection is cached, not retried');
  await assert.rejects(first, /lost browser context/);
  await assert.rejects(again, /lost browser context/);
  await assert.rejects(state.finalizeDraw(), /lost browser context/);
  state.finalizationError = 'lost browser context'; state.persistSequence(); state.persistSequence();
  assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'conference-sequence.json'))).rows, state.rows);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(paths.dir, 'conference-finalization.json'))).ok, false);
  const goodPaths = { dir: mkdtempSync(join(scratch, 'conference-finalize-test-')) }, good = {};
  conferenceFinalization({ evaluate: async () => { calls++; return { samples: [{ frame: 1 }, { frame: 2 }], failures: [] }; } }, goodPaths, good);
  await good.finalizeDraw(); await good.finalizeDraw();
  assert.equal(calls, 2, 'restored observer is collected once');
  assert.equal(JSON.parse(readFileSync(join(goodPaths.dir, 'conference-final-draw.json'))).samples.length, 2);
});

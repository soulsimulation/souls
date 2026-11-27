import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { conferenceFixtures, conferenceJourney } from './conference-native-page.mjs';
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

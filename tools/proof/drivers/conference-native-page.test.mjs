import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { conferenceFixtures } from './conference-native-page.mjs';
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

test('a story that completed normally is not relabelled as an interruption', async () => {
  const calls = [];
  const receipt = { ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } };
  const speaker = { label: 'Presenter', body: 'body', cli: async (...words) => {
    calls.push(words);
    if (words[0] === 'inspect') return { ok: true, parent: 'lectern' };
    if (words[0] === 'act' && words[1] === 'tell_story' && !words.includes('--wait')) return { ok: true, sequence: 7 };
    return receipt;
  } };
  await assert.rejects(explainConference({ speaker, lecture: 'lectern', question: 'question', interruptStory: true }), /named native refusal/);
  assert(calls.some(words => words[0] === 'act' && words[1] === 'point' && words.includes('toward=question') && words.includes('--wait')),
    'the proposed next action completed before checking whether it interrupted the story');
  assert(!calls.some(([op, word]) => op === 'act' && word === 'clap'), 'no next-gesture claim after an unproved interruption');
});

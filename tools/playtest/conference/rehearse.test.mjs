import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { offersOf } from '../../../v2/client/src/check/offers.mjs';
import { completed, discoverConference, performConference, rehearsalTemplate } from './rehearse.mjs';

const receipt = () => ({ ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } });

test('a sent or accepted command is not proof of completed presentation work', () => {
  assert.throws(() => completed({ ok: true, phase: 'started' }, 'lecture'), /started/);
  assert.throws(() => completed({ ok: false, phase: 'refused', code: 'link-full' }, 'lecture'), /link-full/);
  assert.throws(() => completed({ ok: true, phase: 'done' }, 'lecture'), /terminal receipt/);
});

test('the rehearsal reuses both existing definitions and refuses an incomplete fixture catalog', () => {
  const definitions = ['core-hall_lecture', 'core-conference_question'].map((name) => ({ op: 'define', def: { name } }));
  const scene = rehearsalTemplate({ batches: [{ ops: definitions }] });
  assert.equal(scene.batches[0].ops[0], definitions[0]);
  assert.equal(scene.batches[0].ops[1], definitions[1]);
  assert.throws(() => rehearsalTemplate({ batches: [{ ops: [definitions[0]] }] }), /existing furniture/);
});

test('discovery rejects a client that hides a required argument, before sending any action', async () => {
  const entry = (name) => JSON.parse(readFileSync(new URL(`../../../content/kinds/${name}.json`, import.meta.url), 'utf8'));
  const lecture = offersOf('lectern', entry('hall/lecture'));
  const stand = entry('conference/conference_question'), question = offersOf('question', stand);
  const calls = [];
  const seat = { label: 'Reader', cli: async (...words) => {
    calls.push(words);
    if (words[0] === 'together') return { ok: true, activities: ['hall-lecture', 'speaker-introduction', 'round-of-applause'].map((word) => ({ word, card: word })) };
    if (words[0] === 'inspect') return { ok: true, offers: words[1] === 'lectern' ? lecture : question, card: stand.text.card };
    return { ok: true };
  } };
  await discoverConference({ seat, lecture: 'lectern', question: 'question' });
  delete question.find((o) => o.name === 'post_question').params.words;
  await assert.rejects(discoverConference({ seat, lecture: 'lectern', question: 'question' }), /words argument/);
  assert(calls.every(([word]) => ['help', 'look', 'together', 'inspect'].includes(word)), 'discovery sends reads only');
});

test('a gesture that loses the lectern fails the composition before question or handover', async () => {
  const calls = [];
  let presenterParent = 'ground';
  const seats = Array.from({ length: 5 }, (_, index) => ({ label: String(index), body: `body-${index}`,
    cli: async (...words) => {
      calls.push([index, ...words]);
      if (words[0] === 'inspect') return { ok: true, parent: presenterParent };
      if (words[1]?.startsWith('take_the_lectern:')) presenterParent = 'lectern';
      if (words[1] === 'tell_story') presenterParent = 'ground';
      return receipt();
    },
  }));
  await assert.rejects(performConference({ seats, lecture: 'lectern', question: 'question', benches: ['left', 'right'] }), /story gesture preserves/);
  const firstOffer = calls.findIndex((row) => row[1] === 'together' && row[2] === 'offer');
  assert.equal(calls.slice(0, firstOffer).filter((row) => row[2]?.startsWith('attend:')).length, 4,
    'place-taking forms precede the activity that binds those same role links');
  assert(!calls.some((row) => row[2]?.startsWith('post_question:')));
});

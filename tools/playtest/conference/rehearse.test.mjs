import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completed, performConference, rehearsalTemplate } from './rehearse.mjs';

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

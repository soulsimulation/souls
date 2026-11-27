import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  // Public inspect answers only: do not import the client's implementation into this diagnostic.
  const offer = (name, more = {}) => ({ name, usage: `act ${name}:target`, ...more });
  const lecture = [offer('take_the_lectern', { params: { place: { type: 'slot', of: ['lectern'] } } }),
    offer('attend', { params: { seat: { type: 'slot' } } }), offer('step_down'), offer('leave')];
  const question = [offer('post_question', { params: { words: { type: 'text' } } }),
    ...['mark_answered', 'withdraw_question'].map((name) => offer(name, { who: { link: 'asker' } }))];
  const calls = [];
  const seat = { label: 'Reader', cli: async (...words) => {
    calls.push(words);
    if (words[0] === 'together') return { ok: true, activities: ['hall-lecture', 'speaker-introduction', 'round-of-applause'].map((word) => ({ word, card: word })) };
    if (words[0] === 'inspect') return { ok: true, offers: words[1] === 'lectern' ? lecture : question, card: 'Post a question, then withdraw your request.' };
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

function meetingCast({ refusal = 'already_linked', leaveRises = false, stuckActivity = false } = {}) {
  const calls = [], events = [], parents = Array(5).fill('ground'); let pending = false, sequence = 0;
  const interrupted = new Map();
  const seats = Array.from({ length: 5 }, (_, index) => ({ label: `Person${index}`, soul: `soul${index}`, body: `body${index}`,
    cli: async (...words) => {
      calls.push({ index, words }); events.push(`command:${index}:${words[0]}:${words[1]}`);
      const [verb, form] = words;
      if (verb === 'inspect') return { ok: true, parent: parents[index] };
      if (verb === 'look') return { ok: true, doing: stuckActivity ? ['round-of-applause'] : [] };
      if (verb === 'can') return pending ? { can: 'no', reason: refusal, says: 'question_pending' } : { can: 'yes' };
      if (verb === 'receipt') {
        const replaced = interrupted.get(Number(form));
        return { ok: true, receipt: { going: !replaced, answers: [replaced ? { answer: 'refused', reason: 'left', at: 2 } : { answer: 'accepted', at: 1 }] } };
      }
      if (verb === 'together' && form === 'leave' && leaveRises) parents[index] = 'ground';
      if (verb === 'act') {
        if (form.startsWith('take_the_lectern:')) parents[index] = 'lectern';
        if (form.startsWith('attend:')) parents[index] = words.find(w => w.startsWith('seat=')).slice(5).split('/')[0];
        if (form === 'rise' || form.startsWith('step_down:') || form.startsWith('post_question:')) parents[index] = 'ground';
        if (form.startsWith('post_question:')) pending = true;
        if (form.startsWith('withdraw_question:')) pending = false;
        if (form === 'wave') assert(words.includes('for=1'), 'public wave requires a duration');
        if (form === 'tell_story' && !words.includes('--wait')) { interrupted.set(++sequence, false); return { ok: true, sequence }; }
        if (form === 'point') for (const key of interrupted.keys()) interrupted.set(key, true);
      }
      return receipt();
    } }));
  const observe = async (stage, { seat } = {}) => { events.push(`observe:${seat?.label}:${stage}`); };
  return { seats, calls, events, observe };
}

test('full existing meeting observes command-start before sit, seated wave with its argument, question recovery and final cleanup', async () => {
  const cast = meetingCast();
  const result = await performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'], interruptStory: true });
  assert.equal(result.presentations, 2); assert.equal(result.handover, true); assert.equal(result.interruptedStories, 2);
  const firstSit = cast.events.indexOf('command:1:act:attend:lectern');
  assert(cast.events.indexOf('observe:Person1:attend-start') < firstSit);
  assert(cast.events.indexOf('observe:Person1:attend-done') > firstSit);
  const stages = cast.events.filter(e => e.startsWith('observe:'));
  assert.equal(stages.filter(e => e.endsWith(':rise-done')).length, 8);
  assert(stages.indexOf('observe:Person1:question-refused') < stages.indexOf('observe:Person1:question-recovered'));
  assert.equal(stages.at(-1), 'observe:undefined:conference-clean');
  for (let i = 0; i < 5; i++) assert(cast.calls.some(c => c.index === i && c.words[0] === 'together' && c.words[1] === 'leave' && c.words[2] === 'round-of-applause'));
});

test('activity-driven rise is observed from before leaving without issuing a redundant rise', async () => {
  const cast = meetingCast({ leaveRises: true });
  await performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'] });
  assert.equal(cast.calls.filter(c => c.words[0] === 'act' && c.words[1] === 'rise').length, 1, 'questioner rises explicitly; activity departures already released other seats');
  assert.equal(cast.events.filter(e => e.endsWith(':rise-done')).length, 8);
});

test('an unrelated question refusal stops the meeting before recovery or handover', async () => {
  const cast = meetingCast({ refusal: 'out_of_reach' });
  await assert.rejects(performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'] }), /occupied question link/);
  assert(!cast.events.some(e => e.endsWith(':question-recovered') || e.endsWith(':introduction-start')));
});

test('cleanup cannot pass when an ordinary look still reports the activity', async () => {
  const cast = meetingCast(); let looks = 0;
  // The introduction's first look ends it; subsequent final cleanup read must reject a lingering activity.
  for (const seat of cast.seats) { const cli = seat.cli; seat.cli = async (...words) => words[0] === 'look' && ++looks > 1 ? { ok: true, doing: ['round-of-applause'] } : cli(...words); }
  await assert.rejects(performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'] }), /activities must end/);
  assert(!cast.events.some(e => e.endsWith(':conference-clean')));
});

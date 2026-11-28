import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { completed, discoverConference, performConference, rehearsalTemplate, conferenceMemberships } from './rehearse.mjs';

import { brief } from '../../../v2/client/src/brief/brief.mjs';
import { doingLines } from '../../../v2/client/src/together/members.mjs';

// The same current client projection that the daemon uses for ordinary `look`.
function projectedLook(words = []) {
  const rows = new Map([
    ['world', { id: 'world', name: 'World', kind: 'souls:place', parent: null, path: [], children: 1 }],
    ['room', { id: 'room', name: 'Room', kind: 'souls:room', parent: 'world', path: ['World'], children: 2 }],
    ['body', { id: 'body', name: 'Reader', kind: 'souls:body', soul: 'reader', parent: 'room', path: ['World', 'Room'], children: 0 }],
    ['other', { id: 'other', name: 'Partner', kind: 'souls:body', parent: 'room', path: ['World', 'Room'], children: 0 }],
  ]);
  for (const [i, word] of words.entries()) rows.set(`group${i}`, { id: `group${i}`, name: word,
    kind: `eden:${word.replaceAll('-', '_')}_activity`, parent: 'room', path: ['World', 'Room'], children: 0, started: true,
    members: [{ body: 'body', soul: 'reader', role: 'eden:first' }, { body: 'other', role: 'eden:second' }] });
  return { ok: true, ...brief(rows, { me: 'body', now: 'standing', doing: doingLines(rows, ['reader', 'body']) }) };
}

test('current client look separates standing body state from active native memberships and omits cleared memberships', () => {
  const active = projectedLook(['speaker-introduction']);
  assert.equal(active.doing, 'standing'); assert(Array.isArray(active.in));
  assert(conferenceMemberships(active).some(line => line.includes('speaker-introduction')), 'standing does not mean introduction ended');
  const clear = projectedLook(); assert.equal(clear.doing, 'standing'); assert.equal(Object.hasOwn(clear, 'in'), false);
  assert.deepEqual(conferenceMemberships(clear), []);
  assert(conferenceMemberships(projectedLook(['round-of-applause'])).some(line => line.includes('round-of-applause')));
  for (const bad of [{ ...clear, ok: false }, { ...clear, room: null }, { ...clear, in: 'speaker-introduction' }, { ...clear, in: [null] }])
    assert.throws(() => conferenceMemberships(bad), /activity/);
});

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

function meetingCast({ refusal = 'already_linked', can = 'unknown', current = true, mutateDuplicate = false, missingTerminal = false, wrongSequence = false,
  wrongReadID = false, failRepost = false, leaveRises = false, stuckActivity = false } = {}) {
  const calls = [], events = [], parents = Array(5).fill('ground'); let sequence = 0, posts = 0;
  const question = { words: null, pending: 0, answered: 0 };
  const interrupted = new Map();
  const seats = Array.from({ length: 5 }, (_, index) => ({ label: `Person${index}`, soul: `soul${index}`, body: `body${index}`,
    cli: async (...words) => {
      calls.push({ index, words }); events.push(`command:${index}:${words[0]}:${words[1]}`);
      const [verb, form] = words;
      if (verb === 'inspect') return form === 'question'
        ? { ok: true, id: wrongReadID ? 'another-stand' : form, kind: 'eden:conference_question', state: { ...question } }
        : { ok: true, parent: parents[index] };
      if (verb === 'look') return projectedLook(stuckActivity ? ['round-of-applause'] : []);
      if (verb === 'can') return { ok: true, can, current, ...(can === 'unknown' ? { why: 'not-seen:already_linked' } : can === 'no' ? { reason: refusal } : {}) };
      if (verb === 'receipt') {
        const replaced = interrupted.get(Number(form));
        return { ok: true, receipt: { going: !replaced, answers: [replaced ? { answer: 'refused', reason: 'left', at: 2 } : { answer: 'accepted', at: 1 }] } };
      }
      if (verb === 'together' && form === 'leave' && leaveRises) parents[index] = 'ground';
      if (verb === 'act') {
        if (form.startsWith('take_the_lectern:')) parents[index] = 'lectern';
        if (form.startsWith('attend:')) parents[index] = words.find(w => w.startsWith('seat=')).slice(5).split('/')[0];
        if (form === 'rise' || form.startsWith('step_down:') || form.startsWith('post_question:')) parents[index] = 'ground';
        if (form.startsWith('post_question:')) {
          if (question.pending || failRepost && posts > 0) {
            if (mutateDuplicate) question.words = 'unexpected-replacement';
            return { ok: false, phase: 'refused', reason: refusal, code: refusal, sequence: ++sequence,
              ...(missingTerminal ? {} : { receipt: { sequence: wrongSequence ? sequence + 1 : sequence, answers: [{ answer: 'refused', reason: refusal, at: '2026-01-01T00:00:00.000Z' }] } }) };
          }
          question.words = `text-reference-${++posts}`; question.pending = 1; question.answered = 0;
        }
        if (form.startsWith('mark_answered:')) question.answered = 1;
        if (form.startsWith('withdraw_question:')) Object.assign(question, { words: null, pending: 0, answered: 0 });
        if (form === 'wave') assert(words.includes('for=1'), 'public wave requires a duration');
        if (form === 'tell_story' && !words.includes('--wait')) { interrupted.set(++sequence, false); return { ok: true, sequence }; }
        if (form === 'point') for (const key of interrupted.keys()) interrupted.set(key, true);
      }
      return receipt();
    } }));
  const observe = async (stage, { seat } = {}) => { events.push(`observe:${seat?.label}:${stage}`); };
  return { seats, calls, events, observe, question };
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
  assert.deepEqual(cast.question, { words: null, pending: 0, answered: 0 });
  assert.equal(cast.calls.filter(c => c.words[0] === 'act' && c.words[1] === 'post_question:question').length, 3,
    'unknown can reaches native duplicate refusal, then a real new post proves recovery');
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

test('a definite local refusal remains local; advisory yes still requires the native refusal and real recovery', async () => {
  for (const [can, current] of [['no', true], ['yes', true], ['no', false]]) {
    const cast = meetingCast({ can, current });
    await performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'] });
    assert.equal(cast.calls.filter(c => c.words[0] === 'act' && c.words[1] === 'post_question:question').length, can === 'no' && current ? 2 : 3);
    assert.deepEqual(cast.question, { words: null, pending: 0, answered: 0 });
  }
});

test('question proof rejects missing native refusal, overwritten original, wrong stand and failed real recovery', async () => {
  for (const [options, message] of [
    [{ missingTerminal: true }, /terminal native refusal/],
    [{ wrongSequence: true }, /identifies the submitted command/],
    [{ mutateDuplicate: true }, /preserves the original question words/],
    [{ wrongReadID: true }, /identifies the original stand/],
    [{ failRepost: true }, /post_question: already_linked/],
  ]) {
    const cast = meetingCast(options);
    await assert.rejects(performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'] }), message);
    assert(!cast.events.some(e => e.endsWith(':question-recovered') || e.endsWith(':introduction-start')));
  }
});

test('cleanup cannot pass when an ordinary look still reports the activity', async () => {
  const cast = meetingCast(); let looks = 0;
  // The introduction's first look ends it; subsequent final cleanup read must reject a lingering activity.
  for (const seat of cast.seats) { const cli = seat.cli; seat.cli = async (...words) => words[0] === 'look' && ++looks > 1 ? projectedLook(['round-of-applause']) : cli(...words); }
  await assert.rejects(performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'] }), /activities must end/);
  assert(!cast.events.some(e => e.endsWith(':conference-clean')));
});


test('the concise proof can deliberately interrupt only the first speaker while preserving full default behavior', async () => {
  const cast = meetingCast();
  const result = await performConference({ ...cast, lecture: 'lectern', question: 'question', benches: ['left', 'right'],
    interruptStory: true, interruptFirstOnly: true });
  assert.equal(result.interruptedStories, 1); assert.equal(result.presentations, 2);
  assert.equal(cast.events.filter(e => e.endsWith(':tell-story')).length, 1);
  assert.equal(cast.calls.filter(c => c.words[0] === 'act' && c.words[1] === 'tell_story' && !c.words.includes('--wait')).length, 1);
});


test('authored speaker faces the actual audience and listeners face the stage in both helper and tracked scene', () => {
  const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
  const canonical = read('../../../content/kinds/hall/lecture.json');
  const bench = read('../../../content/kinds/seating/bench.json');
  const scene = rehearsalTemplate(read('../../../worlds/templates/eden-2026.json'));
  const tracked = read('../../../worlds/templates/conference-rehearsal.json');
  assert.deepEqual(tracked, scene, 'boot template and ordinary helper must have identical placement/definitions');
  const rotate = (p, yaw) => [Math.cos(yaw)*p[0]+Math.sin(yaw)*p[2],p[1],-Math.sin(yaw)*p[0]+Math.cos(yaw)*p[2]];
  const world = (place, local) => rotate(local,place.r??0).map((n,i)=>n+place.p[i]);
  const dotToward = (forward, from, to) => {
    const d=[to[0]-from[0],0,to[2]-from[2]], length=Math.hypot(...d);
    assert(length>0,'facing target must be spatially distinct');
    return forward.reduce((sum,n,i)=>sum+n*d[i]/length,0)/Math.hypot(...forward);
  };
  const facing = template => {
    const placed=template.batches.flatMap(b=>b.ops).filter(o=>o.op==='place');
    const lectern=placed.find(o=>o.name==='presentation-lectern');
    const slot=canonical.slots.lectern, stand=canonical.points[slot.stand];
    assert.deepEqual(slot.at_mm,stand.at_mm,'speaker arrives at the canonical standing slot');
    // Native form arrival has no explicit face here: from the reached point it faces the thing origin.
    assert.equal(stand.yaw_mdeg,undefined);
    const local=slot.at_mm.map(n=>n/1000),speaker=world(lectern,local);
    const forward=rotate([-local[0],0,-local[2]],lectern.r??0);
    const listeners=placed.filter(o=>o.name.startsWith('audience-')).flatMap(place=>Object.values(bench.slots).map(seat=>({
      position:world(place,seat.at_mm.map(n=>n/1000)),
      // The production seated-heading convention faces local +Z turned by seat yaw then parent yaw.
      forward:rotate(rotate([0,0,1],(seat.yaw_mdeg??0)*Math.PI/180000),place.r??0),
    })));
    assert.equal(listeners.length,4);
    const centroid=[0,1,2].map(i=>listeners.reduce((sum,p)=>sum+p.position[i],0)/listeners.length);
    return {speaker:dotToward(forward,speaker,centroid),listeners:listeners.map(p=>dotToward(p.forward,p.position,speaker))};
  };
  const current=facing(scene);assert(current.speaker>.99,'speaker must address the actual audience centroid');
  assert(current.listeners.every(dot=>dot>.9),'each listener must face the speaker on stage');
  const old=structuredClone(scene);old.batches.flatMap(b=>b.ops).find(o=>o.name==='presentation-lectern').r=0;
  assert(facing(old).speaker<-.99,'the prior backwards-facing arrangement must fail the geometric condition');
});

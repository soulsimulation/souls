// 0.135 (the audit of #4700): what a Soul is told of the activities it is in, and reads of them, from the copy's rows.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
// The pin Eden serves its dance by (the client names no activity of its own).
const DANCE = 'eden:dance_together_activity@1220543a9d3587368b26535d8be47d25e08f30ba23549b9adf3a312b91da91ad3731';
import { activityCard, doingLines, memberNotes, shownEvent, slotsCard } from './members.mjs';

const id = (n) => `${'ab'.repeat(16)}-${n}`;
const [me, meBody, bo, boBody, dance, crew, beam, bay, ground] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
const mine = [me, meBody];
const rows = new Map([
  [meBody, { id: meBody, name: 'Ada', kind: 'souls:body', soul: me, parent: ground }],
  [boBody, { id: boBody, name: 'Bo', kind: 'souls:body', soul: bo, parent: ground }],
  [dance, { id: dance, name: 'dance 5', kind: DANCE.split('@')[0], parent: ground, started: true,
    members: [{ role: 'eden:one', body: meBody, soul: me }, { role: 'eden:two', body: boBody, soul: bo }] }],
  [crew, { id: crew, name: 'carry 6', kind: 'mars:carry_activity', parent: ground, started: false,
    members: [{ role: 'mars:front', body: boBody, soul: bo }, { role: 'mars:back', body: meBody, soul: me }] }],
  [beam, { id: beam, name: 'rack beam 7', kind: 'mars:rack_beam', parent: crew }],
  [bay, { id: bay, name: 'rack bay 8', kind: 'mars:rack_bay', parent: ground }],
  [id(10), { id: id(10), name: 'rack upright 10', kind: 'mars:rack_upright', parent: bay }],
]);
const entry = (name, fields = {}, more = {}) => ({ sequence: 9, actor: bo, node: dance, changes: 2, events: [{ name, fields }], ...more });

test('the offerer hears another join, the start, a leave and the end, each by name, its own join left out', () => {
  const shown = (e) => memberNotes(e, mine).map((n) => shownEvent(rows, n, { mine }));
  assert.deepEqual(shown(entry('souls:activity-joined')), [{ kind: 'together', what: 'joined', activity: dance, touch: 'dance-together', who: 'Bo' }]);
  assert.deepEqual(shown(entry('souls:activity-joined', {}, { actor: me })), [], 'its own join has its receipt');
  assert.deepEqual(shown(entry('souls:activity-started', {}, { actor: null })), [{ kind: 'together', what: 'started', activity: dance, touch: 'dance-together' }]);
  assert.deepEqual(shown(entry('souls:activity-left')), [{ kind: 'together', what: 'left', activity: dance, touch: 'dance-together', who: 'Bo',
    note: `Bo left the dance-together; you are the only one left in it, and it holds you (other acts are refused) until you leave: together leave ${dance}` }]);
  // The leave that removes the activity is its end; one gone from the copy is still named by the kinds kept.
  const end = memberNotes(entry('souls:activity-left', {}, { actor: me, removed: [dance] }), mine)[0];
  assert.deepEqual(shownEvent(new Map(), end, { mine, kinds: new Map([[dance, DANCE]]) }), { kind: 'together', what: 'ended', activity: dance, touch: 'dance-together' });
  assert.deepEqual(shown(entry('souls:activity-ended', { 1: dance, 2: 'souls:thing-gone' }, { actor: null, node: meBody })),
    [{ kind: 'together', what: 'ended', activity: dance, touch: 'dance-together', why: 'thing-gone' }]);
});

test('a carry set down tells each carrier why, the load by name; a decline is named as its activity, not a conversation', () => {
  const n = memberNotes(entry('souls:carry-set-down', { 1: crew, 2: beam, 3: 'souls:partner-left' }, { actor: null, node: crew }), mine);
  assert.deepEqual(shownEvent(rows, n[0], { mine }), { kind: 'carry', what: 'set-down', activity: crew, why: 'partner-left', load: 'rack beam 7', load_id: beam });
  // Who declined comes as the event's list (field 3), CBOR in hex as `wireEntry` gives a list: here [[scope, 4]].
  const list = Buffer.concat([Buffer.from([0x81, 0x82, 0x50]), Buffer.from('ab'.repeat(16), 'hex'), Buffer.from([0x04])]).toString('hex');
  const declined = { kind: 'conversation', what: 'declined', conversation: dance, who: list };
  assert.deepEqual(shownEvent(rows, declined, { mine }), { kind: 'together', what: 'declined', activity: dance, touch: 'dance-together', who: 'Bo' });
  const offered = { kind: 'together', what: 'offered', touch: 'hug', offer: id(11), from: boBody };
  assert.deepEqual(shownEvent(rows, offered, { mine }), { ...offered, from: 'Bo', from_id: boBody });
});

test('look names the activities this Soul is in and with whom; inspect gives members, roles and the leave', () => {
  assert.deepEqual(doingLines(rows, mine), [
    `you are in dance-together with Bo (started); leave: together leave ${dance}`,
    `you are in carry with Bo (not started yet); leave: carry leave ${crew}`,
  ]);
  assert.deepEqual(activityCard(rows, rows.get(crew), mine), {
    activity: 'carry', started: false, leave: `carry leave ${crew}`,
    members: [{ name: 'Bo', role: 'front', body: boBody }, { name: 'you', role: 'back', body: meBody }],
  });
  assert.equal(activityCard(rows, rows.get(beam), mine), null);
});

test('inspect on a bay shows each slot, what fills it, and what is left to build', () => {
  const entryOf = { slots: { upright_a: { admits: 'thing', kinds: ['mars:rack_upright'] }, upright_b: { admits: 'thing', kinds: ['mars:rack_upright'] }, beam_high_l: { admits: 'thing', kinds: ['mars:rack_beam'] } } };
  const card = slotsCard(rows, rows.get(bay), entryOf, (n) => (n === id(10) ? 1 : null));
  assert.deepEqual(card, {
    slots: [{ slot: 'upright_a', holds: `rack upright 10 (${id(10)})` }, { slot: 'upright_b', empty: true, takes: 'rack upright' }, { slot: 'beam_high_l', empty: true, takes: 'rack beam' }],
    built: '1 of 3 slots filled', left: ['upright_b: a rack upright', 'beam_high_l: a rack beam'],
  });
  assert.equal(slotsCard(rows, rows.get(beam), { slots: { seat: { admits: 'body' } } }, () => null), null);
});

test('one asked is told its offer lapsed, by whom and what, and that nothing is left to accept', () => {
  // The daemon's note: `from` the asker, `word` from the offer it was told of (its node gone from every copy).
  const lapsed = { kind: 'conversation', what: 'lapsed', conversation: id(11), from: boBody, word: 'hug' };
  assert.deepEqual(shownEvent(rows, lapsed, { mine }), {
    kind: 'together', what: 'lapsed', activity: id(11), touch: 'hug', from: 'Bo', from_id: boBody,
    note: "Bo's hug offer ran out before you answered: it is gone, so accept would be refused; ask Bo yourself if you still want to",
  });
  // An accepted pair that never started (the asker busy past its expiry): field 4, the pair.
  const pair = shownEvent(rows, { ...lapsed, pair: id(12), word: 'high-five' }, { mine });
  assert.equal(pair.note, "you accepted Bo's high-five, but it never started before it ran out: it is over, nothing to leave");
  // The asker's own lapse is as it was: who did not answer, no note.
  assert.deepEqual(shownEvent(rows, { kind: 'conversation', what: 'lapsed', conversation: dance, who: [boBody] }, { mine }),
    { kind: 'together', what: 'lapsed', activity: dance, touch: 'dance-together', who: 'Bo' });
});

test('look says plainly why this Soul is alone in an activity and what it can do', () => {
  const alone = (started) => new Map([...rows].filter(([k]) => k !== crew).map(([k, r]) => [k, k === dance ? { ...r, started, members: r.members.slice(0, 1) } : r]));
  assert.deepEqual(doingLines(alone(false), mine), [`you offered dance-together and no one has accepted yet: wait for an answer, or take it back: together leave ${dance}`]);
  assert.deepEqual(doingLines(alone(true), mine), [`you are alone in dance-together: the others left, and it holds you (other acts are refused) until you leave: together leave ${dance}`]);
  // Another's leave, with one still in it besides this Soul.
  const three = new Map(rows).set(dance, { ...rows.get(dance), members: [...rows.get(dance).members, { role: 'eden:two', body: id(13), soul: id(14) }] }).set(id(13), { id: id(13), name: 'Cy', kind: 'souls:body', soul: id(14) });
  const [left] = memberNotes(entry('souls:activity-left'), mine).map((n) => shownEvent(three, n, { mine }));
  assert.match(left.note, /^Bo left the dance-together; you are still in it with Cy, and it holds you/);
  // A crew holds hands, not the whole body; read after this Soul is out of it, the note claims nothing about now.
  const [crewLeft] = memberNotes(entry('souls:activity-left', {}, { node: crew }), mine).map((n) => shownEvent(rows, n, { mine }));
  assert.equal(crewLeft.note, `Bo left the carry; you are the only one left in it; leave: carry leave ${crew}`);
  const gone = new Map([...rows].filter(([k]) => k !== dance));
  const [late] = memberNotes(entry('souls:activity-left'), mine).map((n) => shownEvent(gone, n, { mine, kinds: new Map([[dance, DANCE]]) }));
  assert.equal(late.note, 'Bo left the dance-together');
});

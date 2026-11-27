import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counterState, counterDone, rehearseCounterMatch } from './rehearse.mjs';
const done = () => ({ ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } });

// Independent public replies: never import client builders, native rules, entry internals or private fixture ids.
function publicGame({ players = 3, busy = false, declined = false, staleTurn = false, wrongWinner = false, stuckLeave = false } = {}) {
  const calls = [], members = new Map(), board = 'observed-table', activity = 'observed-invitation';
  let offered = false, remaining = 7, turn = 'first';
  const card = 'Play 1 vs 1–3; second_stand/second_back/second_far; last counter wins.';
  const acts = { take_1_first: 'first-one', take_2_first: 'first-two', take_1_second: 'second-one', take_2_second: 'second-two', restart: 'new-round' };
  const inspectBoard = () => ({ ok: true, id: board, card, state: { remaining, turn }, offers: Object.entries(acts).map(([name, alias]) => ({ name, act: `${alias}:${board}`, ...(name.endsWith('second') ? { params: { stand: { type: 'part' } } } : {}) })) });
  const seats = Array.from({ length: players }, (_, i) => ({ label: `player-${i}`, body: `body-${i}`, cli: async (...words) => {
    calls.push({ i, words }); const [op, sub, id] = words;
    if (op === 'help') return { ok: true, commands: ['look', 'find', 'inspect', 'can', 'act', 'together', 'events'] };
    if (op === 'look') return { ok: true, in: busy ? ['you are already in another activity'] : members.has(i) ? [`you are in counter-match (started); leave: together leave ${activity}`] : [] };
    if (op === 'together' && sub === 'kinds') return { ok: true, activities: [{ word: 'counter-match', card, asks: 3, where: 'at a counter match (eden:counter_match)' }] };
    if (op === 'find') return { ok: true, found: [{ id: board, name: 'counter-match', kind: 'eden:counter_match' }] };
    if (op === 'inspect' && sub === board) return inspectBoard();
    if (op === 'inspect' && sub === activity) return { ok: true, id: activity, activity: 'counter-match', started: members.size > 1, members: [...members].map(([index, role]) => ({ body: `body-${index}`, role })), leave: `together leave ${activity}` };
    if (op === 'together' && sub === 'offer') { offered = true; members.set(0, 'first'); return done(); }
    if (op === 'events') return { ok: true, events: [
      { kind: 'together', what: 'offered', offer: 'unrelated-old-invitation', touch: 'counter-match', from_id: 'body-0' },
      ...(offered ? [{ kind: 'together', what: 'offered', offer: activity, touch: 'counter-match', from_id: 'body-0' }] : [])] };
    if (op === 'together' && sub === 'accept') {
      assert.equal(id, activity, 'only the actual current invitation may be accepted');
      if (declined) return { ok: false, phase: 'refused', code: 'offer-declined' };
      members.set(i, 'second'); return done();
    }
    if (op === 'together' && sub === 'leave') { assert.equal(id, activity); if (!(stuckLeave && i === players - 1)) members.delete(i); return done(); }
    if (op === 'can') {
      if (i === 0 && ![...members.values()].includes('second')) return { ok: true, can: 'no', current: true, reason: 'not_linked', says: 'other_side_missing' };
      if (i > 0 && (turn === 'first' || staleTurn)) return { ok: true, can: 'no', current: true, reason: 'field_differs', says: 'first_to_play' };
      return { ok: true, can: 'yes', current: true };
    }
    if (op === 'act') {
      const form = Object.entries(acts).find(([, alias]) => sub === `${alias}:${board}`)?.[0]; assert(form, 'use public offer aliases');
      if (form === 'restart') { remaining = 7; turn = 'first'; }
      else {
        if (i > 0) assert(words.includes(`stand=${['second_stand', 'second_back', 'second_far'][i - 1]}`), 'each second-side player keeps its discovered approach');
        remaining -= form.includes('_2_') ? 2 : 1; turn = i === 0 ? 'second' : 'first';
        if (wrongWinner && remaining === 0) turn = 'first';
      }
      return done();
    }
    throw new Error(`unexpected public command ${op} ${sub}`);
  } }));
  return { seats, calls, members };
}
const run = fixture => rehearseCounterMatch({ seats: fixture.seats, sleep: async () => {} });

test('turn and inferred winner require actual valid state; receipts must be terminal', () => {
  assert.deepEqual(counterState({ ok: true, state: { remaining: 0, turn: 'second' } }), { remaining: 0, turn: 'second', winner: 'first' });
  assert.equal(counterState({ ok: true, state: { remaining: 3, turn: 'first' } }).winner, null);
  assert.throws(() => counterState({ ok: true, state: { turn: 'first' } }), /observed counter count/);
  assert.throws(() => counterDone({ ok: true, phase: 'started' }, 'take'));
});

test('ordinary discovery, exact invitation, late teammate, refusal recovery, winner and leaves are recorded', async () => {
  const fixture = publicGame(), report = await run(fixture);
  assert.equal(report.complete, true); assert.equal(report.finished.winner, 'first');
  assert.equal(report.initialMembers.members.length, 2); assert.equal(report.allMembers.members.length, 3);
  assert.equal(report.refusalRecovery.wrongTurn.says, 'first_to_play'); assert.equal(report.refusalRecovery.completedSecondTake, true);
  assert.deepEqual(report.departures, ['player-2', 'player-1']); assert.equal(fixture.members.size, 0);
  assert.equal(report.independentCollaborationProved, false);
  assert(fixture.calls.some(c => c.words.includes('first-one:observed-table')));
  assert(!fixture.calls.some(c => c.words.includes('take_1_first:observed-table')));
});

test('the same composition works for the intended two-person layout without inventing a late teammate', async () => {
  const report = await run(publicGame({ players: 2 }));
  assert.equal(report.allMembers.members.length, 2); assert.deepEqual(report.departures, ['player-1']);
});

test('the four-person diagnostic keeps three accepted teammates and distinct named approaches', async () => {
  const fixture = publicGame({ players: 4 }), report = await run(fixture);
  assert.equal(report.allMembers.members.length, 4);
  assert.deepEqual(report.departures, ['player-3', 'player-2', 'player-1']);
  assert.equal(fixture.members.size, 0);
});

test('prior membership stops before any activity offer or act', async () => {
  const fixture = publicGame({ busy: true });
  await assert.rejects(run(fixture), /players must be free/);
  assert(!fixture.calls.some(c => c.words[0] === 'act' || c.words[0] === 'together' && c.words[1] === 'offer'));
});

test('declined consent stops before any counter action', async () => {
  const fixture = publicGame({ declined: true });
  await assert.rejects(run(fixture), /offer-declined/);
  assert(!fixture.calls.some(c => c.words[0] === 'act'));
});

test('a continuing definite wrong-turn refusal prevents claiming recovery', async () => {
  const fixture = publicGame({ staleTurn: true });
  await assert.rejects(run(fixture), /definite refusal/);
  assert.equal(fixture.calls.filter(c => c.words[0] === 'act').length, 1);
});

test('an inconsistent final next-turn cannot name the last taker as winner', async () => {
  await assert.rejects(run(publicGame({ wrongWinner: true })), /turn readback/);
});

test('a leave receipt cannot hide retained membership', async () => {
  await assert.rejects(run(publicGame({ stuckLeave: true })), /departed player/);
});

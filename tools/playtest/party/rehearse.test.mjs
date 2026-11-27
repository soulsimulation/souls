import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completed, partyTemplate, performParty } from './rehearse.mjs';

const receipt = () => ({ ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } });

test('the party cannot count a pending or refused intent as a completed action', () => {
  assert.throws(() => completed({ ok: true, phase: 'started' }, 'dance'), /started/);
  assert.throws(() => completed({ ok: false, code: 'body-in-activity' }, 'dance'), /body-in-activity/);
});

test('the scene uses the existing jukebox shape and places it outside the dance space', () => {
  const entry = JSON.parse(readFileSync(new URL('../../../content/kinds/music/jukebox.json', import.meta.url)));
  const scene = partyTemplate(entry), [definition, placement] = scene.batches[0].ops;
  assert.equal(definition.def.name, 'core-jukebox');
  assert.equal(definition.def.make.args.shapes.length, entry.looks.shape.shapes.length);
  assert(placement.p[0] - entry.geometry.bounds_mm[0] / 2000 > 3);
});

// Independent public reply fixtures: these intentionally do not import the client catalogue/member builders.
function publicParty({ busy = false, musicOn = false, endAllOnLeave = false, refuseAccept = false, leaveStuck = false, missingRole = false, capacity = 7 } = {}) {
  const calls = [], members = new Set(), activity = 'party-offer-id'; let offered = false, lastSpeech;
  const seats = Array.from({ length: 5 }, (_, index) => ({ label: String(index), body: `body-${index}`, cli: async (...words) => {
    calls.push([index, ...words]); const [op, sub] = words;
    if (op === 'help') return { ok: true, commands: ['look', 'inspect', 'together', 'say', 'events', 'receipt'] };
    if (op === 'together' && sub === 'kinds') return { ok: true, activities: [{ word: 'dance-together', card: 'A dance on one beat; offer and leave freely.', asks: capacity, near: 'any distance', where: 'anywhere' }] };
    if (op === 'look') return { ok: true, in: busy && !offered ? ['you are in another activity (started)'] : members.has(index) ? [members.size === 1 && index === 0 ? `you offered dance-together and no one has accepted yet: wait for an answer, or take it back: together leave ${activity}` : `you are in dance-together with the group (started); leave: together leave ${activity}`] : [] };
    if (op === 'say') { lastSpeech = sub; return { ok: true, sequence: 1, to: { sequence: 2 } }; }
    if (op === 'receipt') return { ok: true, receipt: { answers: [{ answer: 'receipt' }] } };
    if (op === 'events') return { ok: true, events: [{ kind: 'heard', words: lastSpeech }, { kind: 'together', what: 'declined', touch: 'dance-together', activity: 'unrelated-old-offer' }, { kind: 'together', what: 'offered', touch: 'dance-together', from_id: 'body-0', offer: 'unrelated-old-offer' }, ...(offered ? [{ kind: 'together', what: 'offered', touch: 'dance-together', from_id: 'body-0', offer: activity }] : [])] };
    if (op === 'inspect' && sub === 'jukebox') return { ok: true, state: { on: musicOn ? 1 : 0 } };
    if (op === 'inspect' && sub === activity) return { ok: true, id: activity, activity: 'dance-together', started: true, members: [...members].map((i) => ({ body: `body-${i}`, name: String(i), ...(missingRole ? {} : { role: i === 0 ? 'one' : 'other' }) })), leave: `together leave ${activity}` };
    if (op === 'together' && sub === 'offer') { offered = true; members.add(0); return receipt(); }
    if (op === 'together' && sub === 'accept') {
      assert.equal(words[2], activity, 'accept the actual invitation id');
      if (refuseAccept && index === 2) return { ok: false, phase: 'refused', code: 'offer-declined' };
      members.add(index); return receipt();
    }
    if (op === 'together' && sub === 'leave') {
      assert.equal(words[2], activity, 'leave the inspected activity id');
      if (endAllOnLeave) members.clear(); else if (!(leaveStuck && index === 0)) members.delete(index);
      return receipt();
    }
    if (op === 'act') return receipt();
    throw new Error(`unexpected public party command ${op} ${sub}`);
  } }));
  return { seats, calls, members };
}
const run = (fixture) => performParty({ seats: fixture.seats, mode: 'silent', jukebox: 'jukebox', pause: async () => {} });

test('public discovery, consent, roles, independent departure and final cleanup retain exact membership', async () => {
  const fixture = publicParty(), report = await run(fixture);
  assert.equal(report.people, 5); assert.equal(report.allLeft, true);
  assert.equal(report.discovery.length, 5); assert.equal(report.invitations.length, 4);
  assert.equal(report.membership.length, 5); assert(report.membership.every((row) => row.members.length === 5));
  assert.equal(report.continued.length, 4); assert(report.continued.every((row) => row.members.length === 4));
  assert(report.finalMembership.every((row) => row.in.length === 0)); assert.equal(fixture.members.size, 0);
  assert.equal(report.soundProved, false); assert.equal(report.independentCollaborationProved, false);
  for (let i = 0; i < 5; i++) assert(fixture.calls.some((row) => row[0] === i && row[1] === 'together' && row[2] === 'kinds'));
  assert(!fixture.calls.some((row) => row[2]?.startsWith('switch_')));
});

test('an early departure that ends everyone’s dance fails before a success report', async () => {
  const fixture = publicParty({ endAllOnLeave: true });
  await assert.rejects(run(fixture), /look must name exactly one selected dance/);
  assert.equal(fixture.calls.filter((row) => row[1] === 'together' && row[2] === 'leave').length, 1);
});

test('silent mode refuses a jukebox that is already on instead of claiming silence', async () => {
  const fixture = publicParty({ musicOn: true });
  await assert.rejects(run(fixture), /remain off/);
  assert(!fixture.calls.some((row) => row[1] === 'together' && row[2] === 'offer'));
});

test('an existing activity stops setup before greetings, gestures or a queued offer', async () => {
  const fixture = publicParty({ busy: true });
  await assert.rejects(run(fixture), /every member free/);
  assert(!fixture.calls.some((row) => ['say', 'act'].includes(row[1]) || row[1] === 'together' && row[2] !== 'kinds'));
});

test('a declined acceptance stops before any unconsented guest or started-dance claim', async () => {
  const fixture = publicParty({ refuseAccept: true });
  await assert.rejects(run(fixture), /offer-declined/);
  assert(!fixture.calls.some((row) => row[0] === 3 && row[1] === 'together' && row[2] === 'accept'));
  assert(!fixture.calls.some((row) => row[1] === 'together' && row[2] === 'leave'));
});

test('a served dance with too few invited places is rejected before actions', async () => {
  const fixture = publicParty({ capacity: 3 });
  await assert.rejects(run(fixture), /capacity must admit/);
  assert(!fixture.calls.some((row) => row[1] === 'say' || row[1] === 'act'));
});

test('missing public roles fail even when all accepts completed', async () => {
  const fixture = publicParty({ missingRole: true });
  await assert.rejects(run(fixture), /public role/);
});

test('a final leave receipt cannot hide a member still in the public activity', async () => {
  const fixture = publicParty({ leaveStuck: true });
  await assert.rejects(run(fixture), /all members leave/);
});

test('object-free silent party never inspects or operates a jukebox and forwards the required wave duration', async () => {
  const fixture = publicParty(), phases = [];
  const report = await performParty({ seats: fixture.seats, mode: 'silent', jukebox: null,
    pause: async () => {}, observe: async (stage, details) => { phases.push({ stage, seat: details.seat?.body, seats: details.seats?.length }); } });
  assert.equal(report.jukebox, 'not-present'); assert.equal(report.soundProved, false);
  assert(!fixture.calls.some(row => row[1] === 'inspect' && row[2] === 'jukebox'));
  assert.deepEqual(fixture.calls.find(row => row[1] === 'act' && row[2] === 'wave'), [4, 'act', 'wave', 'for=1', '--wait']);
  assert.deepEqual(phases.map(p => p.stage), ['greeting-start', 'greeting-done', 'reply-start', 'reply-done',
    'dance-ready', 'dance-sustained', 'departure-start', 'departure-done', 'cleanup-start', 'party-clean']);
  assert.equal(phases.find(p => p.stage === 'departure-done').seats, 4);
});

test('page refusal to observe all dancers prevents choreography from silently continuing', async () => {
  const fixture = publicParty();
  await assert.rejects(performParty({ seats: fixture.seats, mode: 'silent', jukebox: null, pause: async () => {},
    observe: async stage => { if (stage === 'dance-ready') throw Error('missing actual dancer'); } }), /missing actual dancer/);
  assert(!fixture.calls.some(row => row[1] === 'together' && row[2] === 'leave'));
});

test('jukebox mode cannot silently turn into an object-free party', async () => {
  await assert.rejects(performParty({ seats: publicParty().seats, mode: 'jukebox', jukebox: null }), /needs its ordinary discovered thing/);
});

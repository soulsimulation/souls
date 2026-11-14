// DLG1: dialogue is visible to spectators; faded (absent) Souls cannot be invited; ignored invitations
// tell the inviter quickly; viewers learn the standing fade roster on join and every sweep.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commsFixture} from './edge/comms/testing.ts';

const pair = (options = {}) => {
  const f = commsFixture(['Alice', 'Bob', 'Cleo'], options);
  f.at('Alice', 0, 0); f.at('Bob', 3, 0); f.at('Cleo', 0, 4);
  const seen: any[] = []; f.runtime.onSpectator(m => seen.push(m));
  return {f, seen};
};

test('say and conversation turns reach spectators with speaker, channel and text', async () => {
  const {f, seen} = pair();
  try {
    await f.post('Alice', '/v1/edge/say', {text: 'Morning, all.'});
    const cv = (await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Bob')], text: 'A word?'})).body.conversation.id;
    await f.post('Bob', '/v1/edge/converse', {op: 'accept', conversation: cv});
    await f.post('Bob', '/v1/edge/converse', {op: 'say', conversation: cv, text: 'Of course.'});
    await f.post('Bob', '/v1/edge/converse', {op: 'leave', conversation: cv});
    assert.deepEqual(seen.map(m => [m.type, m.kind]), [['edge', 'speech'], ['edge', 'conversation.turn'], ['edge', 'conversation.start'], ['edge', 'conversation.member'], ['edge', 'conversation.turn'], ['edge', 'conversation.member'], ['edge', 'conversation.closed']]);
    assert.deepEqual([seen[0].from.name, seen[0].text, seen[0].channel.kind], ['Alice', 'Morning, all.', 'earshot']);
    assert.deepEqual([seen[4].turn.from.name, seen[4].turn.text, seen[4].conversation], ['Bob', 'Of course.', cv]);
    assert.deepEqual(seen.filter(m => m.kind === 'conversation.member').map(m => [m.soul.name, m.change]), [['Bob', 'joined'], ['Bob', 'left']]);
  } finally { f.destroy(); }
});

test('an ignored invitation expires after 2 minutes and the inviter hears invite-expired', async () => {
  const {f} = pair();
  try {
    const cv = (await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Bob')], text: 'Hello?'})).body.conversation.id;
    f.clock.now += 60_000; f.runtime.sweep();
    assert.equal((await f.drain('Alice')).events.filter(e => e.kind.startsWith('conversation.')).length, 0, 'not yet');
    f.clock.now += 60_001; f.runtime.sweep();
    const alice = (await f.drain('Alice')).events.filter(e => e.kind.startsWith('conversation.'));
    assert.deepEqual(alice.map(e => [e.kind, e.change ?? e.reason, e.soul?.name ?? null, e.reason ?? null]), [['conversation.member', 'invite-expired', 'Bob', 'no-answer'], ['conversation.closed', 'invite-expired', null, 'invite-expired']]);
    assert.equal((await f.drain('Bob')).events.at(-1).reason, 'invite-expired');
    assert.equal((await f.post('Bob', '/v1/edge/converse', {op: 'accept', conversation: cv})).body.code, 'conversation.unknown');
  } finally { f.destroy(); }
});

test('faded Souls cannot be invited or hear; a pending invite to one expires at the next sweep; roster for viewers', async () => {
  const {f, seen} = pair({fading: true, beam: true, conversationTimeoutMs: 3 * 3600_000, inviteTimeoutMs: 3 * 3600_000});  // isolate fading from timeouts
  try {
    f.runtime.sweep();                                        // first sight: everyone green
    assert.deepEqual(f.runtime.spectatorJoin()[0].souls, []);
    const cv = (await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Cleo')]})).body.conversation.id;
    f.clock.now += 61 * 60_000;
    await f.post('Alice', '/v1/edge/say', {text: 'Anyone?'});  // Alice acts: stays
    f.runtime.sweep();                                        // Bob and Cleo fade
    assert.equal(f.runtime.fading.status(f.id('Bob'))!.colour, 'gone');
    const refused = (await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Bob')]})).body;
    assert.deepEqual([refused.accepted, refused.code], [false, 'soul.faded']);
    assert.match(refused.reason, /Bob faded/);
    const alice = (await f.drain('Alice')).events.filter(e => e.kind.startsWith('conversation.'));
    assert.deepEqual(alice.map(e => [e.conversation, e.change ?? e.reason, e.reason ?? null]), [[cv, 'invite-expired', 'soul.faded'], [cv, 'invite-expired', 'invite-expired']]);
    const said = (await f.post('Alice', '/v1/edge/say', {text: 'Hello?'})).body;
    assert.equal(said.said.heardBy, 0, 'faded neighbours do not hear');
    const join = f.runtime.spectatorJoin().filter(m => !m.replay);
    assert.deepEqual(join.map(m => [m.type, m.kind]), [['edge', 'fade.roster']]);
    assert.deepEqual((join[0].souls as any[]).map(s => [s.soulId, s.colour]).sort(), [['s_bob', 'gone'], ['s_cleo', 'gone']]);
    assert.ok(seen.some(m => m.kind === 'fade.roster' && (m.souls as any[]).length === 2), 'roster re-broadcast each sweep');
    await f.post('Bob', '/v1/edge/say', {text: 'I am back.'});  // any accepted act reclaims
    assert.equal(f.runtime.fading.status(f.id('Bob'))!.colour, 'green');
    assert.equal((await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Bob')]})).body.accepted, true);
  } finally { f.destroy(); }
});

test('a newly joined viewer gets the recent dialogue from the durable tables as replay, bounded, newest kept', async () => {
  const {f} = pair({fading: true});
  try {
    assert.deepEqual(f.runtime.spectatorJoin().filter(m => m.replay), [], 'empty before anyone speaks');
    await f.post('Alice', '/v1/edge/say', {text: 'Morning, all.'});
    f.clock.now += 1000;
    const cv = (await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Bob')], text: 'A word?'})).body.conversation.id;
    await f.post('Bob', '/v1/edge/converse', {op: 'accept', conversation: cv});
    f.clock.now += 1000;
    await f.post('Bob', '/v1/edge/converse', {op: 'say', conversation: cv, text: 'Of course.'});
    f.runtime.publishWorld('Rain is coming.');                 // world narration is not dialogue
    const join = f.runtime.spectatorJoin();
    assert.equal(join[0].kind, 'fade.roster', 'standing roster first');
    const replay = join.filter(m => m.replay) as any[];
    assert.deepEqual(replay.map(m => m.kind), ['speech', 'conversation.turn', 'conversation.turn']);
    assert.ok(replay.every(m => m.type === 'edge' && typeof m.at === 'number' && typeof m.tick === 'number' && m.untrusted === true));
    assert.deepEqual([replay[0].from, replay[0].text, replay[0].channel.kind, replay[0].heardBy], [{soulId: f.id('Alice'), name: 'Alice'}, 'Morning, all.', 'earshot', [f.id('Bob'), f.id('Cleo')]]);
    assert.deepEqual(replay.slice(1).map(m => [m.conversation, m.turn.seq, m.turn.from.name, m.turn.text]), [[cv, 1, 'Alice', 'A word?'], [cv, 2, 'Bob', 'Of course.']]);
    assert.deepEqual([replay[2].state, replay[2].members.map((m: any) => m.name)], ['open', ['Alice', 'Bob']]);
    // Live and replayed shapes agree, so a viewer folds both the same way.
    const live: any[] = []; f.runtime.onSpectator(m => live.push(m));
    await f.post('Alice', '/v1/edge/converse', {op: 'say', conversation: cv, text: 'Thanks.'});
    const lastReplay = (f.runtime.spectatorJoin().at(-1) as any);
    assert.deepEqual(lastReplay.turn, live.find(m => m.kind === 'conversation.turn').turn);
    for (let i = 0; i < 130; i++) { f.clock.now += 10; await f.post('Cleo', '/v1/edge/say', {text: `line ${i}`}); }
    const bounded = f.runtime.spectatorJoin().filter(m => m.replay);
    assert.equal(bounded.length, 120);
    assert.equal(bounded.at(-1)!.text, 'line 129', 'newest kept');
  } finally { f.destroy(); }
});

// #2269 (Gene, 13 Nov): out loud by default, private on request. Canaries as in #2259's audit: every spectator
// message, live (`onSpectator`, which http.ts broadcasts to every viewer socket) and on join (`spectatorJoin`, the
// socket's join messages with the replay), is serialized and searched for the planted strings.
test('a private conversation reaches viewers only as a talking cue; an out-loud one stays visible', async () => {
  const {f, seen} = pair();
  const PRIVATE = ['CANARY-PRIV-open-7f3a', 'CANARY-PRIV-reply-91c2'], LOUD = ['CANARY-LOUD-open-2b8e', 'CANARY-LOUD-reply-c04d'];
  try {
    const priv = (await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Bob')], text: PRIVATE[0], private: true})).body.conversation;
    assert.equal(priv.private, true, 'the start reply says it is private');
    await f.post('Bob', '/v1/edge/converse', {op: 'accept', conversation: priv.id});
    await f.post('Bob', '/v1/edge/converse', {op: 'say', conversation: priv.id, text: PRIVATE[1]});
    const loud = (await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Cleo')], text: LOUD[0]})).body.conversation;
    assert.equal(loud.private, undefined, 'out loud by default');
    await f.post('Cleo', '/v1/edge/converse', {op: 'accept', conversation: loud.id});
    await f.post('Cleo', '/v1/edge/converse', {op: 'say', conversation: loud.id, text: LOUD[1]});
    await f.post('Alice', '/v1/edge/say', {text: 'CANARY-SAY-5e61'});
    const live = JSON.stringify(seen), join = JSON.stringify(f.runtime.spectatorJoin());
    for (const c of PRIVATE) { assert.ok(!live.includes(c), `${c} not live`); assert.ok(!join.includes(c), `${c} not replayed`); }
    for (const c of [...LOUD, 'CANARY-SAY-5e61']) { assert.ok(live.includes(c), `${c} live`); assert.ok(join.includes(c), `${c} replayed`); }
    // Viewers see that Alice and Bob talk: start, membership and a cue per turn, never a turn record.
    const ofPriv = seen.filter(m => m.conversation === priv.id);
    assert.deepEqual(ofPriv.map(m => m.kind), ['conversation.talking', 'conversation.start', 'conversation.member', 'conversation.talking']);
    assert.ok(ofPriv.every(m => m.turn === undefined && m.text === undefined));
    assert.deepEqual(ofPriv.filter(m => m.kind === 'conversation.talking').map(m => [m.from.name, m.private]), [['Alice', true], ['Bob', true]]);
    assert.equal(ofPriv.find(m => m.kind === 'conversation.start').private, true);
    assert.ok(!JSON.parse(join).some((m: any) => m.conversation === priv.id), 'no private turn in the replay');
    // Members still get every turn: on their stream and from the turns read.
    assert.ok((await f.drain('Bob')).events.some(e => e.kind === 'conversation.invite' && e.text === PRIVATE[0] && e.private === true));
    assert.ok((await f.drain('Alice')).events.some(e => e.kind === 'conversation.turn' && e.turn.text === PRIVATE[1]));
    assert.deepEqual((await f.get('Alice', `/v1/edge/conversations/${priv.id}/turns?after=0`)).body.turns.map((t: any) => t.text), PRIVATE);
    assert.equal((await f.post('Alice', '/v1/edge/converse', {op: 'start', with: [f.id('Bob')], private: 'yes'})).status, 400, 'private is a boolean');
  } finally { f.destroy(); }
});

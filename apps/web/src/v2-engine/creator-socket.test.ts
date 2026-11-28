// 0.133 G1: the old god panel's undo, redo and weather as the creator's edits on its socket, and its command box on the
// creator's mailbox.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decode, encode } from 'cborg';
// the page modules it loads read `location` when loaded
Object.assign(globalThis, { location: { origin: 'http://localhost:5960', pathname: '/w/eden/', search: '', hash: '', href: 'http://localhost:5960/w/eden/' } });
const { CLOSED, CreatorSession, V2Creator, creatorGrant, creatorToken, idOf, mayCreate, prayerRefusal, settledRefusal, refusalText, ticketOf, weatherSets, lightningSets, VERB } = await import('./creator-socket.ts');
const { shownPrayer, soulIdOf } = await import('../god-ui/Prayers.tsx');
const { MailBox, NothingOwned, V2OwnerMailbox } = await import('./owner-mailbox.ts');

const SCOPE = '2b'.repeat(16), CREATOR = `creator-${SCOPE}-7`, WORLD = `${'1a'.repeat(16)}.1`;
const cbor = { encode, decode } as never;
const dec = (b: Uint8Array) => decode(b, { useMaps: true }) as Map<number, unknown>;
const version = (n: number) => [new Uint8Array(16), [new Uint8Array(16), 0], 0, n];
const answer = (sequence: number, kind: 1 | 2, n: number, reason?: string) => encode(new Map<number, unknown>([[1, version(n)], [2, new Map<number, unknown>([[2, sequence], [3, kind], ...(reason ? [[4, reason] as [number, string]] : [])])]]));

/** A session signed in on a stand-in socket that keeps what the page sent. */
function signedIn() {
  const sent: Uint8Array[] = [], texts: string[] = [];
  const s = new CreatorSession({ send: (b) => { if (typeof b === 'string') texts.push(b); else sent.push(b); } }, cbor, idOf(CREATOR.replace(/^creator-/, '')), 'tok-1', 100);
  s.frame(encode(new Map([[1, 2]])));          // the gateway's first frame: the page signs in
  s.frame(encode(new Map([[4, 'stream.started']])));
  return { s, sent, texts };
}

test('the session says hello, signs in with the exchanged token by message, and opens on the gateway\'s outcome', () => {
  const { s, sent } = signedIn();
  assert.deepEqual([...dec(sent[0]!)], [[1, 2], [2, new Uint8Array(0)]], 'T10 hello, protocol 2');
  assert.deepEqual([...dec(sent[1]!)], [[1, 'tok-1']], 'the sign-in carries the token (a browser sets no headers)');
  assert.equal(s.state, 'open');
});

test('undo and redo are the creator\'s souls:edit intents ({5: 1}, {5: 2}); the receipt resolves the press', async () => {
  const { s, sent } = signedIn();
  const undo = s.edit({ undo: 'undo' });
  const i = dec(sent.at(-1)!);
  assert.deepEqual([...(i.get(1) as Map<number, unknown>)], [[1, 2], [2, [Uint8Array.from(Buffer.from(SCOPE, 'hex')), 7]]], 'by the creator');
  assert.equal(i.get(2), VERB);
  assert.deepEqual([...(i.get(4) as Map<number, unknown>)], [[5, 1]]);
  assert.equal(i.get(5), 100, 'the first sequence');
  s.frame(answer(100, 1, 9));
  assert.equal((await undo).t, 'receipt');
  void s.edit({ undo: 'redo' });
  const r = dec(sent.at(-1)!);
  assert.deepEqual([...(r.get(4) as Map<number, unknown>)], [[5, 2]]);
  assert.equal((r.get(6) as unknown[])[3], 9, 'planned against the newest version an answer carried');
});

test('a refusal is answered by name; a stale weather is sent once more against the newer version', async () => {
  const { s, sent } = signedIn();
  const rain = s.edit(weatherSets(WORLD, 'rain', 5_000_000_000));
  const ops = (dec(sent.at(-1)!).get(4) as Map<number, unknown>).get(1) as Map<number, unknown>[];
  assert.deepEqual(ops.map((o) => [o.get(1), o.get(3), o.get(4)]), [[3, 75, 'souls:rain'], [3, 76, 90], [3, 77, 60], [3, 78, 30], [3, 65, 5_000_000_000 + 3_600_000_000]],
    'E6\'s five weather fields on the world node, as the creator client\'s weather sets them, for an hour');
  assert.deepEqual(ops[0]!.get(2), [Uint8Array.from(Buffer.from('1a'.repeat(16), 'hex')), 1]);
  s.frame(answer(100, 2, 12, 'edit.stale'));
  const again = dec(sent.at(-1)!);
  assert.equal(again.get(5), 101, 'sent again under a new sequence');
  assert.equal((again.get(6) as unknown[])[3], 12, 'against the version the refusal carried');
  s.frame(answer(101, 2, 12, 'edit.weather-no-sky'));
  assert.deepEqual(await rain, { t: 'refused', sequence: 101, version: version(12), reason: 'edit.weather-no-sky' });
  const undo = s.edit({ undo: 'undo' });
  s.frame(answer(102, 2, 12, 'undo.nothing'));
  assert.equal((await undo as { reason: string }).reason, 'undo.nothing', 'the panel\'s note shows the refusal\'s name');
});

test('edits are numbered by the clock, never below the last, so the creator\'s agent (also by the clock) and the page never lock each other out', async () => {
  const sent: Uint8Array[] = [];
  let now = 5_000;
  const s = new CreatorSession({ send: (b) => sent.push(b as Uint8Array) }, cbor, idOf(CREATOR.replace(/^creator-/, '')), 'tok-1', 100, () => now);
  s.frame(encode(new Map([[1, 2]]))); s.frame(encode(new Map([[4, 'stream.started']])));
  void s.edit({ undo: 'undo' });
  assert.equal(dec(sent.at(-1)!).get(5), 5_000, 'the clock, above the first');
  void s.edit({ undo: 'redo' });
  assert.equal(dec(sent.at(-1)!).get(5), 5_001, 'the same instant: one more than the last');
  now = 9_000;
  void s.edit({ undo: 'undo' });
  assert.equal(dec(sent.at(-1)!).get(5), 9_000, 'later: the clock again');
});

test('a sequence the creator\'s agent has out at that moment (the gateway\'s intent.seq-in-use, #5006) is sent once more under the next', async () => {
  const { s, sent } = signedIn();
  const press = s.edit({ undo: 'undo' });
  // The gateway's own refusal: no version, on this socket alone.
  s.frame(encode(new Map<number, unknown>([[2, new Map<number, unknown>([[2, 100], [3, 2], [4, 'intent.seq-in-use']])]])));
  assert.equal(dec(sent.at(-1)!).get(5), 101, 'sent again under the next sequence');
  s.frame(answer(101, 1, 4));
  assert.equal((await press).t, 'receipt');
  const twice = s.edit({ undo: 'redo' });
  s.frame(answer(102, 2, 4, 'intent.seq-in-use'));
  s.frame(answer(103, 2, 4, 'intent.seq-in-use'));
  assert.equal((await twice as { reason: string }).reason, 'intent.seq-in-use', 'once only');
});

test('a socket that closes answers every waiting press creator.closed, in plain words, instead of leaving it Sending for ever (the edit may have been made)', async () => {
  const { s } = signedIn();
  const a = s.edit({ undo: 'undo' }), b = s.edit({ ops: [{ op: 'remove', node: WORLD }] });
  s.closed();
  assert.deepEqual([(await a as { reason: string }).reason, (await b as { reason: string }).reason], [CLOSED, CLOSED]);
  assert.match(refusalText(CLOSED), /answer did not reach this page.*look at the world before you press again/);
  s.frame(answer(100, 1, 3));   // a late answer finds nothing waiting
});

test('Build\'s place, move and remove are the batch\'s operations 1, 2 and 4; the receipt names the placed thing', async () => {
  const { s, sent } = signedIn();
  const HASH = '1220' + 'ab'.repeat(32), GROUND = `${'1a'.repeat(16)}.3`, BENCH = `${'1a'.repeat(16)}.40`;
  const built = s.edit({ ops: [{ op: 'place', name: 1, kind: `eden:bench@${HASH}`, parent: GROUND, at: { x: 1_000_000, y: 250_000.4, z: -2_000_000 } },
    { op: 'move', node: BENCH, at: { x: 3, y: 0, z: 4 }, rot: [0, 0, 1 << 30, 0] }, { op: 'remove', node: BENCH }] });
  const [place, move, remove] = (dec(sent.at(-1)!).get(4) as Map<number, unknown>).get(1) as Map<number, unknown>[];
  assert.deepEqual([...place!.keys()], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([place!.get(1), place!.get(2), place!.get(3)], [1, 1, 'eden:bench'], 'the plain name, its hash apart');
  assert.deepEqual(place!.get(4), Uint8Array.from(Buffer.from(HASH, 'hex')));
  assert.deepEqual(place!.get(5), [Uint8Array.from(Buffer.from('1a'.repeat(16), 'hex')), 3]);
  assert.deepEqual([...(place!.get(6) as Map<number, unknown>)], [[1, [1_000_000, 250_000, -2_000_000]], [2, [1 << 30, 0, 0, 0]], [3, new Map([[1, 0]])]], 'whole µm, facing as its parent, on nothing');
  assert.deepEqual([move!.get(1), (move!.get(2) as unknown[])[1]], [2, 40]);
  assert.deepEqual((move!.get(3) as Map<number, unknown>).get(2), [0, 0, 1 << 30, 0], 'a move keeps the thing\'s facing');
  assert.deepEqual([...remove!], [[1, 4], [2, [Uint8Array.from(Buffer.from('1a'.repeat(16), 'hex')), 40]]]);
  s.frame(encode(new Map<number, unknown>([[1, version(3)], [2, new Map<number, unknown>([[2, 100], [3, 1], [6, new Map([[1, [Uint8Array.from(Buffer.from('1a'.repeat(16), 'hex')), 41]]])]])]])));
  const f = await built;
  assert.equal(f.t === 'receipt' && f.names.get(1), `${'1a'.repeat(16)}.41`, 'the new thing\'s id, as the stream keys it');
  assert.match(refusalText('edit.would-bury'), /^Refused: edit\.would-bury \(a Soul stands there now/, 'build safety\'s refusal by name, in plain words');
  assert.equal(refusalText('edit.node-missing'), 'Refused: edit.node-missing');
});

test('the exchange posts the page\'s session to /v2/creator-token beside the gateway; a refusal is named', async () => {
  const place = { directory: 'http://127.0.0.1:9', gateway: 'ws://127.0.0.1:8/v2/ws', session: { testName: 'Ada' } };
  const asked: [string, RequestInit][] = [];
  const ok = async (url: string, init: RequestInit) => { asked.push([url, init]); return { ok: true, status: 200, json: async () => ({ token: 't', grant: CREATOR, expires_in: 900 }) }; };
  assert.deepEqual(await creatorToken(place as never, ok as never), { token: 't', grant: CREATOR });
  assert.equal(asked[0]![0], 'http://127.0.0.1:8/v2/creator-token');
  assert.equal((asked[0]![1].headers as Record<string, string>).authorization, 'Bearer test:Ada');
  const no = async () => ({ ok: false, status: 403, json: async () => ({ refused: 'not-the-creator' }) });
  await assert.rejects(creatorToken(place as never, no as never), /not-the-creator/);
});

test('the command box puts the creator\'s words in the creator\'s mailbox, the box the creator\'s agent listens on', async () => {
  const owned = [{ grant: `soul-${SCOPE}-2` }, { grant: CREATOR }];
  assert.equal(creatorGrant(owned), CREATOR);
  assert.equal(creatorGrant([{ grant: `soul-${SCOPE}-2` }]), null, 'not the creator: no box');
  const sock = { onText: null as ((t: string) => void) | null, sent: [] as string[], start() {}, stop() {},
    sendText(t: string) { sock.sent.push(t); queueMicrotask(() => sock.onText?.(JSON.stringify({ sent: { id: 'm_1' } }))); return true; } };
  const box = new V2OwnerMailbox(async (self) => self.attach(new MailBox(), sock, creatorGrant(owned)!));
  const inbox = await box.send('Put a well by the square');
  assert.deepEqual(sock.sent, [`put ${CREATOR}\nPut a well by the square`]);
  assert.deepEqual(ticketOf(inbox), { id: 'm_1', text: 'Put a well by the square', state: 'sent', sentAt: ticketOf(inbox)!.sentAt }, 'the command log\'s row');
});

test('the exchange is asked only for an account the directory lists a creator grant for (first day: no 404 on Eden)', async () => {
  const place = { directory: 'http://localhost:5960', gateway: 'ws://localhost:5960/w/eden/v2/ws', session: { page: true } } as never;
  const owning = (...grants: string[]) => async () => ({ owned: grants.map((grant) => ({ grant })) });
  assert.equal(await mayCreate(place, owning(CREATOR)), true, 'a creator is asked');
  assert.equal(await mayCreate(place, owning(`soul-${'ab'.repeat(16)}-1`)), false, 'an owner of Souls only is not');
  assert.equal(await mayCreate(place, async () => { throw new NothingOwned(); }), false, 'a new person, owning nothing, is not');
  assert.equal(await mayCreate(place, async () => { throw new Error('no view: the directory said 500'); }), true, 'a view the directory cannot give leaves it to the exchange');
});

test('27 Nov: a refusal that can pass is asked again, so a new world\'s creator gets God Mode once its gateway knows them', () => {
  for (const r of ['not-the-creator', 'no-creator', 'no-gateway', 'session-refused']) assert.equal(settledRefusal(r), true, r);
  for (const r of ['creator-authority-unavailable', 'creator-authority-changing', 'directory-unreachable', 'the gateway said 502']) assert.equal(settledRefusal(r), false, r);
});

test('#5006: the panel\'s inbox says the creator\'s agent is connected only while the gateway says so', async () => {
  const sock = { onText: null as ((t: string) => void) | null, start() {}, stop() {}, sendText() { return true; } };
  const creator = new V2Creator('stream');
  // the creator's mailbox, as mailbox() attaches it once the view token is held
  Object.assign(creator, { box: new V2OwnerMailbox(async (self) => self.attach(new MailBox(), sock, CREATOR)) });
  const said = async () => { const i = await creator.inbox(); return [i.connected, i.presence]; };
  assert.deepEqual(await said(), [false, 'away'], 'not told yet: not connected, so the panel shows the line for the agent');
  sock.onText!(JSON.stringify({ agent: { grant: CREATOR, connected: true } }));
  assert.deepEqual(await said(), [true, 'listening'], 'its agent signed in for the grant');
  sock.onText!(JSON.stringify({ agent: { grant: `soul-${SCOPE}-2`, connected: false } }));
  assert.deepEqual(await said(), [true, 'listening'], 'another grant\'s agent is not the creator\'s');
  sock.onText!(JSON.stringify({ agent: { grant: CREATOR, connected: false } }));
  assert.deepEqual(await said(), [false, 'away'], 'gone again: the line comes back');
});

test('#5006 row 13: Lightning is a storm for an hour and one strike where the camera looks, as the agent\'s weather and strike set them', async () => {
  const { s, sent } = signedIn();
  void s.edit(lightningSets(WORLD, [12.34, -8], 5_000_000_000));
  const ops = (dec(sent.at(-1)!).get(4) as Map<number, unknown>).get(1) as Map<number, unknown>[];
  assert.deepEqual(ops.map((o) => [o.get(1), o.get(3), o.get(4)]), [[3, 75, 'souls:storm'], [3, 76, 100], [3, 77, 90], [3, 78, 80],
    [3, 65, 5_000_000_000 + 3_600_000_000], [3, 69, [12_340, -8_000, 5_000_000_000]]], 'v2/client world.mjs KINDS.storm and strikeOps');
  assert.deepEqual(lightningSets(WORLD, null, 1), weatherSets(WORLD, 'storm', 1), 'no view yet: the storm alone');
});

test('#5006 row 15: the panel lists and answers prayers by text frames on the creator\'s socket, each reply matched by n; a refusal and a closed socket are named', async () => {
  const { s, texts } = signedIn();
  const SOUL = `soul-${SCOPE}-2`, p = { id: 'p_0a0b0c0d0e0f', soul: SOUL, text: 'let it rain', at: 1_800_000_000, state: 'waiting', answer: null, answered_at: null };
  const listed = s.ask('prayers', { all: false });
  assert.deepEqual(JSON.parse(texts.at(-1)!), { prayers: { all: false, n: 1 } }, 'the frame the gateway passes to the directory (gatewayd mailbox.rs PASSED)');
  const answered = s.ask('answer', { id: p.id, text: 'it will' });
  assert.deepEqual(JSON.parse(texts.at(-1)!), { answer: { id: p.id, text: 'it will', n: 2 } });
  // replies come back in any order, each to its own request; anything else on the socket is not the session's
  s.text(JSON.stringify({ reply: { n: 2, ok: true, prayer: { ...p, state: 'answered', answer: 'it will', answered_at: p.at + 5 } } }));
  s.text(JSON.stringify({ mail: { id: 'm_1', text: 'not a reply' } }));
  s.text('not json');
  s.text(JSON.stringify({ reply: { n: 1, ok: true, prayers: [p] } }));
  assert.deepEqual(await listed, { n: 1, ok: true, prayers: [p] });
  assert.equal((await answered as { prayer: { answer: string } }).prayer.answer, 'it will');
  const other = s.ask('answer', { id: 'p_ffffffffffff', text: 'no' });
  s.text(JSON.stringify({ reply: { n: 3, ok: false, refused: 'prayer.not-found' } }));
  assert.deepEqual(await other, { ok: false, refused: 'prayer.not-found' }, 'another world\'s prayer is not found for this creator');
  assert.equal(prayerRefusal('prayer.not-found'), 'That prayer is not one of this world\'s.');
  const late = s.ask('prayers', {}), slow = s.ask('prayers', {}, 5);
  assert.deepEqual(await slow, { ok: false, refused: 'prayer.unanswered' }, 'no reply in time: named, never waiting for ever');
  s.closed();
  assert.deepEqual(await late, { ok: false, refused: CLOSED });
  // the panel's row: the Soul named as the page names it (its page id from its grant), its time in ms
  assert.equal(soulIdOf(SOUL), `s_${SCOPE}-2`);
  assert.deepEqual(shownPrayer(p as never, (g) => (soulIdOf(g) === `s_${SCOPE}-2` ? 'Moss' : null)), { id: p.id, soul_name: 'Moss', text: 'let it rain', at: 1_800_000_000_000, answer: null, answered_at: null });
  assert.equal(shownPrayer(p as never).soul_name, 'A Soul', 'a Soul the page does not know yet');
});

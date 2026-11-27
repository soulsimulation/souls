// #4178: the old owner box on the v2 gateway mailbox. The box (reading frames as the v2 page's OwnerBox does) is fed
// the gateway's text frames (as gatewayd's mailbox.rs sends them) and the old card's inbox fields are read from what this adapter makes of them
// (AgentMessageBox.tsx's receiptState: sent → "Sent", delivered → "Picked up", acknowledged with a result → "Done",
// with outcome failed → "Could not do it").
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
// the page modules it loads read `location` when loaded
Object.assign(globalThis, { location: { origin: 'http://localhost:5960', pathname: '/w/eden/', search: '', hash: '', href: 'http://localhost:5960/w/eden/' } });
const { MailBox: OwnerBox, V2OwnerMailbox, inboxOf, mailboxPlace, viewToken, NothingOwned } = await import('./owner-mailbox.ts');

const GRANT = `soul-${'2b'.repeat(16)}-2`;

/** A socket that answers each put as the gateway does, and lets the test send the agent's frames. */
function fakeSocket(answer: (frame: string) => object | null) {
  const s = { onText: null as ((t: string) => void) | null, sent: [] as string[], started: false,
    sendText(t: string) { s.sent.push(t); const a = answer(t); if (a) queueMicrotask(() => s.onText?.(JSON.stringify(a))); return true; },
    start() { s.started = true; }, stop() {} };
  return s;
}

test('a message written in the box is put for the Soul\'s grant and its answer shows in the receipt', async () => {
  const sock = fakeSocket(() => ({ sent: { id: 'm1' } }));
  const mb = new V2OwnerMailbox(async (self) => self.attach(new OwnerBox(), sock, GRANT));
  assert.equal((await mb.read()).latest, null);
  assert.ok(sock.started);
  const sent = await mb.send('walk to the library');
  assert.deepEqual(sock.sent, [`put ${GRANT}\nwalk to the library`]);
  assert.equal(sent.latest?.state, 'sent');
  assert.equal(typeof sent.latest?.sentAt, 'number');

  sock.onText!(JSON.stringify({ mail: { id: 'm1', state: 'picked' } }));
  let inbox = await mb.read();
  assert.equal(inbox.latest?.state, 'sent', 'first-day 27 Nov: given to its client is not read by the agent');
  assert.equal(inbox.doing, undefined, 'not Thinking…');
  sock.onText!(JSON.stringify({ mail: { id: 'm1', state: 'read' } }));
  inbox = await mb.read();
  assert.equal(inbox.latest?.state, 'delivered');
  assert.deepEqual(inbox.doing, { phase: 'thinking' });

  sock.onText!(JSON.stringify({ doing: { seq: 1, verb: 'walk', phase: 'running', outcome: null } }));
  inbox = await mb.read();
  assert.deepEqual(inbox.doing, { phase: 'running', text: 'walk' });

  sock.onText!(JSON.stringify({ note: { id: 'm1', reply: 'on my way' } }));
  assert.equal((await mb.read()).latest?.progress, 'on my way');

  sock.onText!(JSON.stringify({ close: { id: 'm1', state: 'done', outcome: 'arrived', reply: 'I am at the library.' } }));
  inbox = await mb.read();
  assert.equal(inbox.latest?.state, 'acknowledged');
  assert.equal(inbox.latest?.reply, 'I am at the library.');
  assert.equal(inbox.latest?.outcome, 'done');
  assert.equal(inbox.latest?.result, 'arrived');
  assert.equal(inbox.queued, 0);
});

test('a refused put throws and is not shown as sent', async () => {
  const sock = fakeSocket(() => ({ sent: { refused: 'not-yours' } }));
  const mb = new V2OwnerMailbox(async (self) => self.attach(new OwnerBox(), sock, GRANT));
  await assert.rejects(mb.send('hello'), /not-yours/);
  assert.equal((await mb.read()).latest, null);
});

test('a put the mailbox never answers fails visibly, and a late answer does not show it as sent', async () => {
  const sock = fakeSocket(() => null);
  const box = new OwnerBox();
  const mb = new V2OwnerMailbox(async (self) => self.attach(box, sock, GRANT));
  await assert.rejects(mb.send('hello', 20), /did not answer/);
  assert.equal((await mb.read()).latest, null);
  sock.onText!(JSON.stringify({ sent: { id: 'late' } }));
  assert.equal((await mb.read()).latest, null);
  assert.equal(box.messages[0].state, 'refused');
});

test('a failed close reads as "Could not do it"', () => {
  const box = new OwnerBox();
  box.put(GRANT, 'sit');
  box.text(JSON.stringify({ sent: { id: 'm2' } }));
  box.text(JSON.stringify({ close: { id: 'm2', state: 'failed', outcome: 'no-seat' } }));
  const inbox = inboxOf(box.messages, new Map(), true);
  assert.equal(inbox.latest?.state, 'acknowledged');
  assert.equal(inbox.latest?.outcome, 'failed');
});

test('the card is told whether the Soul\'s agent is connected (the gateway\'s {"agent"} frame), and nothing before', async () => {
  const sock = fakeSocket(() => null);
  const box = new OwnerBox();
  const mb = new V2OwnerMailbox(async (self) => self.attach(box, sock, GRANT));
  const before = await mb.read();
  assert.equal(before.link, undefined, 'not told yet: no claim, the card says Checking…');
  assert.equal(before.connected, false);
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: true, listening: true } }));
  assert.deepEqual((await mb.read()).link, { state: 'connected', reason: 'listening', since: null, holder: null });
  assert.equal((await mb.read()).connected, true);
  sock.onText!(JSON.stringify({ agent: { grant: `soul-${'9'.repeat(32)}-0`, connected: false } }));
  assert.equal((await mb.read()).connected, true, 'another grant\'s word is not this Soul\'s');
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: false } }));
  assert.equal(((await mb.read()).link as { state?: string } | undefined)?.state, 'disconnected');
});

test('#1330: the box socket down for OUTAGE_MS → unavailable, nothing of the agent; reconnect → normal; a send in between keeps its words', async () => {
  const { OUTAGE_MS, UNAVAILABLE_SEND } = await import('./owner-mailbox.ts');
  let t = 1_000_000, up = true;
  const sock = Object.assign(fakeSocket((f) => (f.startsWith('put ') ? { sent: { id: 'm9' } } : null)), { onOpen: null as ((o: boolean) => void) | null });
  const sendText = sock.sendText;
  sock.sendText = (x: string) => (up ? sendText(x) : false);
  const mb = new V2OwnerMailbox(async (self) => self.attach(new OwnerBox(), sock, GRANT), () => t);
  await mb.read();
  sock.onOpen!(true);
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: true } }));
  assert.equal((await mb.read()).unavailable, undefined, 'open: normal');
  assert.equal(((await mb.read()).link as { state?: string }).state, 'connected');
  // the gateway goes: the socket closes (1013, or just dropped) and keeps failing to reconnect
  up = false; sock.onOpen!(false);
  t += 1000; sock.onOpen!(false);
  assert.equal((await mb.read()).unavailable, undefined, 'one reconnect\'s gap says nothing');
  t += OUTAGE_MS;
  const down = await mb.read();
  assert.equal(down.unavailable, true, 'down for OUTAGE_MS: unavailable');
  assert.equal(down.link, undefined, 'no word on the agent from before the outage');
  assert.equal(down.connected, false);
  await assert.rejects(mb.send('meet me by the well'), (e: Error) => e.message === UNAVAILABLE_SEND, 'a send says the world is unavailable');
  assert.ok(!sock.sent.some((f) => f.includes('meet me')), 'nothing went out');
  // the world comes back: the socket signs in again
  up = true; sock.onOpen!(true);
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: true } }));
  const back = await mb.read();
  assert.equal(back.unavailable, undefined, 'reconnect: normal');
  assert.equal((back.link as { state?: string }).state, 'connected');
  const sent = await mb.send('meet me by the well');
  assert.equal(sent.latest?.text, 'meet me by the well');
  assert.equal(sent.latest?.state, 'sent');
});

test('#1330: a first connection that fails counts as down (a page opened during an outage)', async () => {
  let t = 5_000;
  const sock = Object.assign(fakeSocket(() => null), { onOpen: null as ((o: boolean) => void) | null });
  const mb = new V2OwnerMailbox(async (self) => self.attach(new OwnerBox(), sock, GRANT), () => t);
  await mb.read();
  assert.equal((await mb.read()).unavailable, undefined, 'still making its first connection');
  sock.onOpen!(false);
  t += (await import('./owner-mailbox.ts')).OUTAGE_MS;
  assert.equal((await mb.read()).unavailable, true);
});

test('a mailbox that cannot be reached makes the read throw (the card shows nothing, no claim)', async () => {
  const mb = new V2OwnerMailbox(async () => { throw new Error('no view'); });
  await assert.rejects(mb.read(), /no view/);
});

test('the mailbox place: only on a v2 world; same-origin config paths, loopback overrides and test sign-in', () => {
  const cfg = { v2Gateway: '/w/eden/v2/ws', v2Directory: '/' };
  assert.equal(mailboxPlace('http://localhost:5173/?as=gene', cfg, null), null, 'an old-engine world');
  assert.deepEqual(mailboxPlace('http://localhost:5173/?as=gene', cfg, '/s/eden/'),
    { directory: 'http://localhost:5173', gateway: 'ws://localhost:5173/w/eden/v2/ws', session: { testName: 'gene' } });
  assert.deepEqual(mailboxPlace('http://127.0.0.1:5173/?as=a&gateway=ws://127.0.0.1:9001/v2/ws&directory=http://127.0.0.1:9002', {}, '/s/eden/'),
    { directory: 'http://127.0.0.1:9002', gateway: 'ws://127.0.0.1:9001/v2/ws', session: { testName: 'a' } });
  assert.deepEqual(mailboxPlace('https://example.test/?as=a&gateway=ws://127.0.0.1:9001/v2/ws&directory=/', cfg, '/s/eden/'),
    { directory: 'https://example.test', gateway: 'wss://example.test/w/eden/v2/ws', session: { page: true } }, 'off loopback: the config\'s paths and the page\'s own sign-in, never ?as= or the overrides');
  assert.deepEqual(mailboxPlace('http://localhost:5173/', cfg, '/s/eden/')?.session, { page: true }, 'no ?as=: the page\'s sign-in');
  assert.equal(mailboxPlace('http://localhost:5173/?as=a', { v2Gateway: 'https://elsewhere.test/ws', v2Directory: '/' }, '/s/eden/'), null, 'config names same-origin paths only');
});

test('B3-2: the page\'s sign-in is exchanged for the view token: a provider session as the bearer, a local dev name as the test sign-in', async () => {
  const place = { directory: 'http://127.0.0.1:9002', gateway: 'ws://127.0.0.1:9001/v2/ws', session: { page: true as const } };
  const asked: { url: string; init: RequestInit }[] = [];
  const post = (async (url: string, init: RequestInit) => { asked.push({ url, init }); return new Response(JSON.stringify({ token: 'v', expires: 9, owned: [{ grant: GRANT }] })); }) as typeof fetch;
  assert.deepEqual(await viewToken(place, post, async () => 'provider.jwt'), { token: 'v', expires: 9, owned: [{ grant: GRANT }] });
  assert.equal(asked[0].url, 'http://127.0.0.1:9002/v1/account/view-token');
  assert.deepEqual(asked[0].init.headers, { authorization: 'Bearer provider.jwt' }); assert.equal(asked[0].init.body, undefined);
  await viewToken(place, post, async () => 'dev:Ada');
  assert.equal(asked[1].init.body, JSON.stringify({ name: 'Ada' }), 'a local dev session: the directory\'s test sign-in by that name');
  await assert.rejects(viewToken(place, post, async () => null), /not signed in/);
  assert.equal(asked.length, 2, 'signed out: nothing asked');
});

test('signed in, owning nothing: the directory\'s empty answer (and an older directory\'s 404 nothing-owned) is NothingOwned, not a failure', async () => {
  const place = { directory: 'http://127.0.0.1:9002', gateway: 'ws://127.0.0.1:9001/v2/ws', session: { page: true as const } };
  const empty = (async () => new Response(JSON.stringify({ owned: [] }))) as unknown as typeof fetch;
  await assert.rejects(viewToken(place, empty, async () => 'provider.jwt'), (e) => e instanceof NothingOwned);
  const older = (async () => new Response(JSON.stringify({ refused: 'nothing-owned' }), { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(viewToken(place, older, async () => 'dev:Ada'), (e) => e instanceof NothingOwned);
  const other = (async () => new Response(JSON.stringify({ refused: 'no-view-key' }), { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(viewToken(place, other, async () => 'dev:Ada'), (e) => !(e instanceof NothingOwned) && /no-view-key/.test(String(e)));
});

test('first-day 27 Nov: a client connected with nobody reading is asleep, never listening; Thinking… only once the agent read it', async () => {
  const sock = fakeSocket((f) => (f.startsWith('put ') ? { sent: { id: 'm7' } } : null));
  const mb = new V2OwnerMailbox(async (self) => self.attach(new OwnerBox(), sock, GRANT));
  await mb.read();
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: true, listening: false } }));
  assert.deepEqual((await mb.read()).link, { state: 'connected', reason: 'asleep', since: null, holder: null });
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: true } }));
  assert.equal(((await mb.read()).link as { reason?: string }).reason, 'asleep', 'no word on a reader: not claimed');
  await mb.send('walk Juniper over to the pond');
  sock.onText!(JSON.stringify({ mail: { id: 'm7', state: 'picked' } }));
  const given = await mb.read();
  assert.equal(given.latest?.state, 'sent'); assert.equal(given.doing, undefined);
  assert.equal(given.waitsMs, 15 * 60_000, 'the directory keeps it open 15 min');
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: true, listening: true } }));
  assert.equal(((await mb.read()).link as { reason?: string }).reason, 'listening');
  sock.onText!(JSON.stringify({ mail: { id: 'm7', state: 'read' } }));
  assert.deepEqual((await mb.read()).doing, { phase: 'thinking' });
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: false, listening: true } }));
  assert.equal(((await mb.read()).link as { state?: string }).state, 'disconnected');
  sock.onText!(JSON.stringify({ agent: { grant: GRANT, connected: true } }));
  assert.equal(((await mb.read()).link as { reason?: string }).reason, 'asleep', 'a new sign-in has no reader until it says so');
});

test('first-day 27 Nov: read before the put\'s answer still makes it Thinking…', () => {
  const box = new OwnerBox();
  box.put(GRANT, 'wave');
  box.text(JSON.stringify({ mail: { id: 'm8', state: 'read' } }));
  box.text(JSON.stringify({ sent: { id: 'm8' } }));
  assert.equal(box.messages[0].state, 'thinking');
});

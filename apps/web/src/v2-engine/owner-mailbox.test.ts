// #4178: the old owner box on the v2 gateway mailbox. The v2 page's own OwnerBox is fed the gateway's text frames (as
// gatewayd's mailbox.rs sends them) and the old card's inbox fields are read from what this adapter makes of them
// (AgentMessageBox.tsx's receiptState: sent → "Sent", delivered → "Picked up", acknowledged with a result → "Done",
// with outcome failed → "Could not do it").
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OwnerBox } from '../../../../v2/web/src/owner/box.ts';
// the page modules it loads read `location` when loaded
Object.assign(globalThis, { location: { origin: 'http://localhost:5960', pathname: '/w/eden/', search: '', hash: '', href: 'http://localhost:5960/w/eden/' } });
const { V2OwnerMailbox, inboxOf, mailboxPlace } = await import('./owner-mailbox.ts');

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

test('a failed close reads as "Could not do it"', () => {
  const box = new OwnerBox();
  box.put(GRANT, 'sit');
  box.text(JSON.stringify({ sent: { id: 'm2' } }));
  box.text(JSON.stringify({ close: { id: 'm2', state: 'failed', outcome: 'no-seat' } }));
  const inbox = inboxOf(box.messages, new Map(), true);
  assert.equal(inbox.latest?.state, 'acknowledged');
  assert.equal(inbox.latest?.outcome, 'failed');
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
  assert.equal(mailboxPlace('https://example.test/?as=a&gateway=ws://127.0.0.1:9001/v2/ws&directory=/', cfg, '/s/eden/'), null, 'no test sign-in off loopback');
  assert.equal(mailboxPlace('http://localhost:5173/?as=a', { v2Gateway: 'https://elsewhere.test/ws', v2Directory: '/' }, '/s/eden/'), null, 'config names same-origin paths only');
});

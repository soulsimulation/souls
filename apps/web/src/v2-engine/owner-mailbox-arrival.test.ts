// First day (28 Nov, soul.game 0.150): a just-approved Soul's card said Checking… for its first seconds. Its body arrived
// about 28 s after the approval, and only then did the card open and make the Soul's owner box, whose view-token exchange
// and socket sign-in came after that. Here the page's own path runs against a fake directory and a fake gateway that
// speak the box's protocol: the approval starts the box, so the card that opens at arrival reads Connected at once.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { encode, decode } from 'cborg';

const GRANT = `soul-${'3c'.repeat(16)}-4`;
const g = globalThis as Record<string, unknown>;
// the page as owner-mailbox.ts reads it when it loads: a v2 world's config, signed in by the test name on a loopback page
g.window = globalThis;
g.location = new URL('http://localhost:5960/w/eden/?as=Newcomer');
g.__simConfig = { v2Stream: '/s/w/x-0/views/a/b/', v2Gateway: '/v2/ws', v2Directory: '/' };
const listeners = new Map<string, Set<() => void>>();
g.addEventListener = (n: string, f: () => void) => { (listeners.get(n) ?? listeners.set(n, new Set()).get(n)!).add(f); };
g.removeEventListener = (n: string, f: () => void) => { listeners.get(n)?.delete(f); };
g.dispatchEvent = (e: { type: string }) => { for (const f of listeners.get(e.type) ?? []) f(); return true; };
let exchanges = 0;
g.fetch = async (url: string) => {
  assert.match(String(url), /\/v1\/account\/view-token$/);
  exchanges++;
  return { ok: true, status: 200, json: async () => ({ token: 'view-token', expires: Math.floor(Date.now() / 1000) + 600, owned: [{ grant: GRANT, follow: true }] }) };
};
/** The gateway's view socket: hello, sign-in, view.started, then whether the grant's agent is connected (it is). */
class FakeGateway {
  static opened = 0;
  readyState = 0; binaryType = ''; onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  private step = 0;
  constructor() { FakeGateway.opened++; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5); }
  send(data: Uint8Array | string) {
    if (typeof data === 'string') return;
    const m = decode(data, { useMaps: true }) as Map<number, unknown>;
    const reply = (d: unknown) => setTimeout(() => this.onmessage?.({ data: d }), 5);
    if (this.step === 0 && m.get(1) === 2) { this.step = 1; reply(encode(new Map([[1, 2]])).slice().buffer); }
    else if (this.step === 1 && m.get(1) === 'view-token') {
      this.step = 2;
      reply(encode(new Map([[4, 'view.started']])).slice().buffer);
      reply(JSON.stringify({ agent: { grant: GRANT, connected: true, listening: true } }));
    }
  }
  close() { this.readyState = 3; }
}
g.WebSocket = FakeGateway;

const { v2Approved, v2OwnerMailbox, watchV2OwnerMailbox, OWNED_CHANGED_EVENT } = await import('./owner-mailbox.ts');
const { soulIdOf } = await import('./bridge.ts');
const SOUL = soulIdOf(GRANT);
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test('first day (28 Nov): approving starts the Soul\'s box, so the card that opens at arrival reads Connected at once', async () => {
  let asked = 0;
  (g.addEventListener as (n: string, f: () => void) => void)(OWNED_CHANGED_EVENT, () => asked++);
  // a watch made by a card mounted before any box exists is told once the box is made and the gateway speaks
  let told = 0;
  const stop = watchV2OwnerMailbox(SOUL, () => told++);
  v2Approved(SOUL);
  assert.equal(asked, 1, 'the owned lists are asked again at the approval');
  await settle();   // the body is still on its way: on soul.game it arrives about 28 s later
  assert.equal(exchanges, 1, 'the box exchanged its view token at the approval');
  assert.equal(FakeGateway.opened, 1, 'and signed in its socket');
  assert.ok(told >= 1, 'the card mounted before the box was told when it spoke');
  stop();
  // the body arrives and its card opens: its first read, as useSoulInbox's first poll makes it
  const first = await v2OwnerMailbox(SOUL)!.read();
  assert.deepEqual(first.link, { state: 'connected', reason: 'listening', since: null, holder: null });
  assert.equal(exchanges, 1, 'the card uses the box the approval started');
  v2OwnerMailbox(SOUL)!.stop();
});

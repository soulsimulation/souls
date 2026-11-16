// #2305: a page hidden for five minutes closes its live connection so the launcher can unload the world; shown again it
// reconnects. A god's open edit panel holds the connection. The short knob (hiddenMs) stands in for five minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, releaseWhenHidden } from '@souls/client';

type Fake = { send(s: string): void; close(): void; readyState: number; closed: boolean; onopen: any; onmessage: any; onclose: any; onerror: any };
function rig(t: import('node:test').TestContext, keep?: () => boolean) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const made: Fake[] = [];
  const c = new Connection('ws://world.invalid/ws', async () => null, {}, () => {
    const ws: Fake = { send() {}, closed: false, close() { if (ws.closed) return; ws.closed = true; ws.readyState = 3; ws.onclose?.({ code: 1005 }); }, readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null };
    made.push(ws); return ws;
  });
  const subs = new Set<() => void>();
  const doc = { visibilityState: 'visible', addEventListener: (_: string, f: () => void) => subs.add(f), removeEventListener: (_: string, f: () => void) => subs.delete(f) };
  const show = (v: 'visible' | 'hidden') => { doc.visibilityState = v; for (const f of [...subs]) f(); };
  c.connect();
  const stop = releaseWhenHidden(c, { doc, hiddenMs: 1000, keep });
  t.after(() => { stop(); c.close(); });
  return { made, c, show, subs, stop };
}

test('hidden for hiddenMs: the socket closes and stays closed; shown again: one new socket, no error', (t) => {
  const { made, c, show } = rig(t);
  show('hidden');
  t.mock.timers.tick(999);
  assert.equal(made[0].closed, false, 'still connected before the knob');
  t.mock.timers.tick(1);
  assert.equal(made[0].closed, true, 'released after the knob');
  assert.equal(c.stats.state, 'closed');
  t.mock.timers.tick(60_000);
  assert.equal(made.length, 1, 'a released page does not reconnect while hidden');
  show('visible');
  assert.equal(made.length, 2, 'shown again: reconnects at once');
  assert.equal(c.stats.state, 'connecting');
});

test('a quick tab switch never closes the socket', (t) => {
  const { made, show } = rig(t);
  show('hidden'); t.mock.timers.tick(900); show('visible'); show('hidden'); t.mock.timers.tick(900); show('visible');
  t.mock.timers.tick(5000);
  assert.equal(made[0].closed, false); assert.equal(made.length, 1);
});

test('a god edit panel open holds the connection; closed, the next check lets go', (t) => {
  let panel = true;
  const { made, show } = rig(t, () => panel);
  show('hidden'); t.mock.timers.tick(3000);
  assert.equal(made[0].closed, false, 'held while the panel is open');
  panel = false; t.mock.timers.tick(1000);
  assert.equal(made[0].closed, true, 'released once the panel is closed');
});

test('stop removes the listener and the timer', (t) => {
  const { made, show, subs, stop } = rig(t);
  show('hidden'); stop();
  assert.equal(subs.size, 0);
  t.mock.timers.tick(5000);
  assert.equal(made[0].closed, false);
});

// #1390: the world page's screen wake lock: held while visible, let go when hidden or idle, asked again on show or input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keepAwake, IDLE_MS } from './wake-lock.ts';

function rig(o: { refuse?: boolean } = {}) {
  const docL = new Map<string, () => void>(), winL = new Map<string, () => void>();
  let timers: { fn: () => void; at: number }[] = [], now = 0;
  const sentinels: { released: boolean; release(): Promise<void>; addEventListener(t: string, f: () => void): void; drop(): void }[] = [];
  const env = {
    requests: 0, refuse: !!o.refuse,
    doc: { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (t: string, f: () => void) => { docL.set(t, f); }, removeEventListener: (t: string) => { docL.delete(t); } },
    win: { addEventListener: (t: string, f: () => void) => { winL.set(t, f); }, removeEventListener: (t: string) => { winL.delete(t); } },
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimeout: (t: unknown) => { timers = timers.filter(x => x !== t); },
    wakeLock: { request: (_: 'screen') => { env.requests++; if (env.refuse) return Promise.reject(new Error('NotAllowedError')); let rel = () => {};
      const s = { released: false, release: () => { s.released = true; return Promise.resolve(); }, addEventListener: (_t: string, f: () => void) => { rel = f; }, drop: () => { s.released = true; rel(); } };
      sentinels.push(s); return Promise.resolve(s); } },
  };
  const flush = () => new Promise(r => setImmediate(r));
  const advance = (ms: number) => { now += ms; for (const t of timers.filter(t => t.at <= now)) { timers = timers.filter(x => x !== t); t.fn(); } };
  const show = (v: boolean) => { env.doc.visibilityState = v ? 'visible' : 'hidden'; docL.get('visibilitychange')!(); };
  const input = (ev = 'pointerdown') => winL.get(ev)!();
  return { env, sentinels, flush, advance, show, input, docL, winL };
}

test('held while visible, released when hidden, asked again when shown', async () => {
  const r = rig(), k = keepAwake(r.env); await r.flush();
  assert.equal(k.held(), true); assert.equal(r.env.requests, 1);
  r.show(false); assert.equal(k.held(), false); assert.equal(r.sentinels[0].released, true);
  r.show(true); await r.flush(); assert.equal(k.held(), true); assert.equal(r.env.requests, 2);
  k.stop(); assert.equal(k.held(), false); assert.equal(r.sentinels[1].released, true);
  assert.equal(r.docL.size, 0); assert.equal(r.winL.size, 0, 'no listeners left');
});

test('after 30 minutes without input it lets go; the next input asks again', async () => {
  const r = rig(), k = keepAwake(r.env); await r.flush();
  r.advance(IDLE_MS - 60_000); r.input(); await r.flush();
  r.advance(IDLE_MS - 1000); assert.equal(k.held(), true, 'input restarts the 30 minutes');
  r.advance(1000); assert.equal(k.held(), false); assert.equal(k.idle(), true);
  r.input('keydown'); await r.flush(); assert.equal(k.held(), true); assert.equal(k.idle(), false);
  k.stop();
});

test('a lock the system drops is asked for again on the next show or input', async () => {
  const r = rig(), k = keepAwake(r.env); await r.flush();
  r.sentinels[0].drop(); assert.equal(k.held(), false);
  r.input(); await r.flush(); assert.equal(k.held(), true); assert.equal(r.env.requests, 2);
  k.stop();
});

test('a refused request, a hidden start, and no API are quiet', async () => {
  const r = rig({ refuse: true }), k = keepAwake(r.env); await r.flush();
  assert.equal(k.held(), false); assert.equal(r.env.requests, 1, 'no retry loop');
  r.input(); await r.flush(); assert.equal(r.env.requests, 2, 'tried again only on input');
  k.stop();
  const h = rig(); h.env.doc.visibilityState = 'hidden'; const kh = keepAwake(h.env); await h.flush();
  assert.equal(h.env.requests, 0, 'a hidden page never asks'); kh.stop();
  const n = rig(), kn = keepAwake({ ...n.env, wakeLock: undefined }); await n.flush();
  assert.equal(kn.held(), false); assert.equal(n.winL.size, 0, 'no listeners without the API'); kn.stop();
});

test('a lock granted after the page was hidden is released at once', async () => {
  const r = rig(), k = keepAwake(r.env);
  r.env.doc.visibilityState = 'hidden'; await r.flush();
  assert.equal(k.held(), false); assert.equal(r.sentinels[0].released, true);
  k.stop();
});

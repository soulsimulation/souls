// 0.131 parity C1 (#3673) A1, A2: the world page's fullscreen offer and wake lock, as today's apps/web (fullscreen.ts,
// wake-lock.ts) or better.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullscreenOffer, keepAwake, type WakeEnv } from './screen.ts';

test('A1: the toggle enters and leaves wherever the API is; hidden with no API or in an installed app', () => {
  assert.equal(fullscreenOffer({ api: true, installed: false, fullscreen: false }), 'enter');
  assert.equal(fullscreenOffer({ api: true, installed: false, fullscreen: true }), 'leave');
  assert.equal(fullscreenOffer({ api: false, installed: false, fullscreen: false }), 'none'); // iPhone Safari
  assert.equal(fullscreenOffer({ api: true, installed: true, fullscreen: false }), 'none');
  assert.equal(fullscreenOffer({ api: true, installed: true, fullscreen: true }), 'leave'); // entered by the toggle: a way out
});

function fakeEnv(answer: 'grant' | 'refuse' = 'grant') {
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = 'visible';
  const win = new EventTarget();
  const timers = new Map<number, () => void>();
  let n = 0, requests = 0;
  const sentinels: { released: boolean; release(): Promise<void> }[] = [];
  const env: WakeEnv = {
    wakeLock: {
      request: async () => {
        requests++;
        if (answer === 'refuse') throw new Error('NotAllowedError');
        const t = new EventTarget(), s = { released: false, release: async () => { s.released = true; t.dispatchEvent(new Event('release')); }, addEventListener: (k: 'release', f: () => void) => t.addEventListener(k, f) };
        sentinels.push(s);
        return s;
      },
    },
    doc: doc as unknown as WakeEnv['doc'], win: win as unknown as WakeEnv['win'],
    setTimeout: (f) => (timers.set(++n, f), n), clearTimeout: (t) => void timers.delete(t as number),
  };
  const show = async (v: string) => { doc.visibilityState = v; doc.dispatchEvent(new Event('visibilitychange')); await tick(); };
  return { env, win, show, timers, sentinels, requests: () => requests };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('A2: held while visible, released when hidden, asked again when the tab returns, let go for good on leaving', async () => {
  const f = fakeEnv(), k = keepAwake(f.env);
  await tick();
  assert.ok(k.held());
  await f.show('hidden');
  assert.ok(!k.held() && f.sentinels[0].released);
  await f.show('visible');
  assert.ok(k.held());
  assert.equal(f.requests(), 2);
  k.stop();
  assert.ok(!k.held() && f.sentinels[1].released);
  await f.show('hidden'); await f.show('visible');
  assert.equal(f.requests(), 2, 'no request after the page is left');
});

test('A2: an idle half hour lets the phone sleep; the next input asks again; a system release or refusal stays quiet', async () => {
  const f = fakeEnv(), k = keepAwake(f.env);
  await tick();
  [...f.timers.values()].at(-1)!();
  assert.ok(k.idle() && !k.held());
  f.win.dispatchEvent(new Event('pointerdown'));
  await tick();
  assert.ok(k.held() && !k.idle());
  await f.sentinels[1].release(); // the system drops it (battery)
  assert.ok(!k.held());
  const r = fakeEnv('refuse'), kr = keepAwake(r.env);
  await tick();
  assert.ok(!kr.held());
  const none = keepAwake({ ...f.env, wakeLock: null });
  assert.ok(!none.held());
  k.stop(); kr.stop();
});

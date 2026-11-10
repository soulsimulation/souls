// #1389/#1393: the browser holding the music back (a rejected play(), a context that stays suspended) is shown and
// retried on the next tap, never counted as a broken file; previous/next play when on and only select when off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivalMark } from '../arrival-marks.ts';
import { musicGesture, musicLog, musicState, skipPiece, syncMusic } from './music.ts';
import { musicView } from '../music-status.ts';

type El = { src: string; paused: boolean; plays: number };
// The player keeps its context for the page (as in a browser), so one fake browser serves every test; rig() resets it.
const env = { refuse: false as boolean, ctxState: 'running', resumeWorks: true, elements: [] as El[] };
{
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { requestIdleCallback: (fn: () => void) => fn() } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
    const el = { src: '', currentTime: 0, paused: true, plays: 0, duration: 240, readyState: 1, crossOrigin: '', preload: '', load() {},
      addEventListener() {}, removeEventListener() {}, removeAttribute() { this.src = ''; }, pause() { this.paused = true; },
      play() { this.plays++; if (env.refuse) return Promise.reject(new Error('NotAllowedError: play() failed because the user didn\'t interact with the document first.')); this.paused = false; return Promise.resolve(); } };
    env.elements.push(el); return el;
  } } });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
    currentTime = 0; destination = {};
    get state() { return env.ctxState; }
    createGain() { return { gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    resume() { if (env.resumeWorks) env.ctxState = 'running'; return Promise.resolve(); }
  } });
  arrivalMark('first-live-frame');
}
function rig(_t: unknown) { env.refuse = false; env.ctxState = 'running'; env.resumeWorks = true; env.elements.length = 0; return env; }
const on = { on: true, volume: 0.3, unlocked: true }, flush = () => new Promise(r => setImmediate(r));
async function ticks(n: number, o = on) { for (let i = 0; i < n; i++) { syncMusic(o); await flush(); } }

test('a refused play() waits for a tap, says so, is never a broken file, and a tap plays it', async t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const env = rig(t);
  env.refuse = true;
  await ticks(10);
  assert.equal(musicView().status, 'blocked', 'the menu reads "Tap to play"');
  assert.equal(musicState().playing, null);
  assert.equal(musicState().file.failures, 0, 'not counted as a broken file'); assert.equal(musicState().file.off, false);
  assert.ok(musicLog().some(e => e.ev === 'error' && /^blocked/.test(e.reason ?? '')));
  const tries = env.elements.reduce((n, e) => n + e.plays, 0);
  now += 10_000; await ticks(10);
  assert.equal(env.elements.reduce((n, e) => n + e.plays, 0), tries, 'no retries without a tap');
  const piece = musicState().piece;
  env.refuse = false; musicGesture(); await flush(); await flush();
  assert.equal(musicState().playing, piece, 'the same piece, from the tap');
  syncMusic(on); assert.equal(musicView().status, 'playing');
  syncMusic({ ...on, on: false }); assert.equal(musicView().status, 'off');
});

test('a context that stays suspended is shown as blocked, not On, until a tap resumes it', async t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const env = rig(t);
  env.ctxState = 'suspended'; env.resumeWorks = false;
  await ticks(10);
  assert.equal(musicState().playing, null, 'stopped, its place kept');
  assert.equal(musicView().status, 'blocked');
  env.resumeWorks = true; musicGesture(); await flush(); await flush();
  assert.equal(env.ctxState, 'running');
  await ticks(3); assert.ok(musicState().playing); assert.equal(musicView().status, 'playing');
  // a page that comes back with its context interrupted: shown within BLOCKED_AFTER_MS, then a tap brings it back
  env.ctxState = 'interrupted'; env.resumeWorks = false;
  syncMusic(on); now += 2000; syncMusic(on);
  assert.equal(musicView().status, 'blocked'); assert.equal(musicState().playing, null);
  env.resumeWorks = true; musicGesture(); await flush(); await flush(); await ticks(3);
  assert.equal(musicView().status, 'playing');
  syncMusic({ ...on, on: false });
});

test('previous and next: play from the start when on, only select when off, and wrap round', async t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const env = rig(t);
  syncMusic({ ...on, on: false });
  skipPiece(1); for (let i = 0; i < 20 && !musicState().playlist.length; i++) await flush();   // off: only the order loads
  const list = musicState().playlist, n = list.length; assert.ok(n > 2);
  const i0 = musicState().index;
  assert.equal(musicView().piece, list[i0]); assert.equal(musicView().status, 'off');
  skipPiece(-1); skipPiece(-1); assert.equal(musicState().index, (i0 - 2 + n) % n, 'wraps below 0');
  const made = env.elements.length; assert.equal(musicState().playing, null); assert.equal(env.elements.length, made, 'off: nothing plays');
  const chosen = musicState().index;
  await ticks(5); assert.equal(musicState().playing, list[chosen], 'turned on, the chosen track plays');
  skipPiece(1); assert.equal(musicState().playing, null);
  await ticks(5); assert.equal(musicState().playing, list[(chosen + 1) % n], 'next plays the next one');
  assert.equal(musicLog().filter(e => e.ev === 'stop' && e.reason === 'next').length, 1);
  skipPiece(-1); await ticks(5); assert.equal(musicState().playing, list[chosen], 'previous');
  for (let i = 0; i < n; i++) skipPiece(1);
  await ticks(5); assert.equal(musicState().playing, list[chosen], 'a full round comes back');
  syncMusic({ ...on, on: false });
});

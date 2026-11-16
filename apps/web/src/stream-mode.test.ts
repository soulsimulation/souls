// #2492 ?stream=1: the input lock keeps the Broadcast camera; the frame counter; the label; lazy loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cameraModeAfterGesture } from './WorldViewer.ts';
import type { WorldCameraMode } from './WorldBroadcast.ts';
import { lockInput, STREAM_CSS, STREAM_INPUT_EVENTS, streamFrame, streamHealth, streamLabelText, streamRequested } from './stream-mode.ts';

const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

// The page's own camera input, as LiveWorld, WorldRtsCamera and WorldTouchFree wire it: any gesture takes Broadcast to
// manual (cameraModeAfterGesture), a drag or wheel moves the camera, a key walks it, a touch follows or flies.
function camera(win: EventTarget) {
  const cam = { mode: 'broadcast' as WorldCameraMode, eye: [0, 10, 20], seen: 0 };
  const gesture = (e: Event) => {
    cam.seen++; cam.mode = cameraModeAfterGesture(cam.mode);
    if (e.type.startsWith('key')) cam.mode = 'manual'; if (e.type.startsWith('touch')) cam.mode = 'follow';
    cam.eye = [cam.eye[0] + 1, cam.eye[1], cam.eye[2] - 1];
  };
  for (const type of STREAM_INPUT_EVENTS) win.addEventListener(type, gesture);  // bubble phase (React, the canvas)
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) win.addEventListener(type, gesture, { capture: true });  // capture (navigation, RTS)
  return cam;
}
const input = (type: string) => { const e = new Event(type, { cancelable: true, bubbles: true }); return e; };

test('A1: without the lock, each input kind takes the camera off Broadcast (the control case)', () => {
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) {
    const win = new EventTarget(), cam = camera(win);
    win.dispatchEvent(input(type));
    assert.notEqual(cam.mode, 'broadcast', type); assert.ok(cam.seen > 0, type);
  }
});

test('A1: with ?stream=1 pointer, mouse, wheel, keyboard and touch input never switch or move the camera', () => {
  const win = new EventTarget(); lockInput(win); const cam = camera(win), eye = [...cam.eye];
  for (const kind of [['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu'], ['mousedown', 'mousemove', 'mouseup'],
    ['wheel'], ['keydown', 'keypress', 'keyup'], ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gestureend']]) {
    for (const type of kind) {
      const e = input(type); win.dispatchEvent(e);
      assert.equal(e.defaultPrevented, true, type + ' default (page scroll, zoom, context menu) prevented');
    }
    assert.equal(cam.mode, 'broadcast', kind.join()); assert.deepEqual(cam.eye, eye, kind.join()); assert.equal(cam.seen, 0, kind.join());
  }
});

test('A1: the lock comes undone (a page that leaves stream mode gets its input back)', () => {
  const win = new EventTarget(), undo = lockInput(win), cam = camera(win); undo();
  win.dispatchEvent(input('wheel')); assert.equal(cam.mode, 'manual');
});

test('A5: every drawn frame counts, with the wall clock of the last one', () => {
  const before = streamHealth.frames;
  streamFrame(1_000); streamFrame(1_016);
  assert.equal(streamHealth.frames, before + 2); assert.equal(streamHealth.lastFrameAt, 1_016);
  assert.deepEqual(Object.keys(streamHealth).sort(), ['frames', 'lastFrameAt']);
});

test('A2: the label, and the page shows only the canvas, the name tags with their spoken lines, and the label', () => {
  assert.equal(streamLabelText('Little Martians'), 'Little Martians · soul.game');
  assert.equal(streamLabelText('  '), 'A world · soul.game');
  assert.match(STREAM_CSS, /html\.souls-stream body \*\{visibility:hidden!important\}/);
  assert.match(STREAM_CSS, /\.world-canvas-host:not\(\[style\*="visibility: hidden"\]\) canvas,/); assert.match(STREAM_CSS, /\.world-name-tag \*/);
  assert.match(STREAM_CSS, /cursor:none/); assert.match(STREAM_CSS, /\.world-viewport\{position:fixed!important;inset:0/);
});

test('A5: only ?stream=1 asks for it, and the stream code is loaded only then', () => {
  assert.equal(streamRequested('?stream=1'), true);
  for (const q of ['', '?shot=1', '?stream=0', '?stream']) assert.equal(streamRequested(q), false, q);
  for (const f of ['./LiveWorld.tsx', './Shell.tsx']) {
    const s = src(f);
    assert.doesNotMatch(s, /^import[^\n]*stream-mode/m, f + ' imports stream-mode statically');
    assert.match(s, /get\('stream'\)==='1'/, f); assert.match(s, /import\('\.\/stream-mode\.ts'\)/, f);
  }
  assert.match(src('./visitor-counts.ts'), /has\('stream'\)\) return null/);
});

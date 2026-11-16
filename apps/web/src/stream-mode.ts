// #2492 ?stream=1: a world page as a clean broadcast feed for a live stream (a real Chrome window captured by OBS; the
// stream tool of #2493 opens it). Loaded only on ?stream=1 (Shell.tsx and LiveWorld.tsx import it dynamically).
//   - the Broadcast camera stays on: every pointer, mouse, wheel, key and touch event is stopped at the window, in the
//     capture phase, before the camera, the HUD or React see it (lockInput);
//   - the picture only: the view fills the window; everything else is hidden except the canvas (black until the arrival
//     is over), the Souls' name tags with their spoken lines (the dialogue pop-ups), and a quiet
//     `<world name> · soul.game` label in the bottom right; no cursor;
//   - sound at the default settings from load, with no gesture, where the browser allows autoplay
//     (gen-mesh/sound.ts `__edenSound.startNow`, repeated every 2 s so a suspended context wakes again);
//   - health: `window.__soulsStream = { frames, lastFrameAt }` counts drawn frames (LiveWorld calls streamFrame after
//     each draw); lastFrameAt is the wall clock (Date.now, ms) of the last one, 0 before the first.
// Full resolution (no adaptive resolution, pixel ratio up to 2) is in adaptive-resolution.ts worldResolution.

/** The page is in stream mode: `?stream=1`. */
export const streamRequested = (search: string) => new URLSearchParams(search).get('stream') === '1';

/** Every input kind a visitor (or a stray click on the capture machine) can give. */
export const STREAM_INPUT_EVENTS = [
  'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
  'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu',
  'wheel', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'gesturestart', 'gesturechange', 'gestureend', 'dragstart', 'selectstart',
] as const;

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Stops every input event at `win` in the capture phase: nothing after it (the camera, the HUD, React) sees one.
 *  Install it on `window`, which is the first stop of every event's path. Returns the undo. */
export function lockInput(win: Target): () => void {
  const stop = (e: Event) => { e.stopImmediatePropagation(); e.stopPropagation(); if (e.cancelable) e.preventDefault(); };
  for (const type of STREAM_INPUT_EVENTS) win.addEventListener(type, stop, { capture: true, passive: false });
  return () => { for (const type of STREAM_INPUT_EVENTS) win.removeEventListener(type, stop, { capture: true }); };
}

export type StreamHealth = { frames: number; lastFrameAt: number };
/** The frame counter the stream tool's watchdog reads as `window.__soulsStream`. */
export const streamHealth: StreamHealth = { frames: 0, lastFrameAt: 0 };
/** One drawn frame. */
export function streamFrame(now = Date.now()) { streamHealth.frames++; streamHealth.lastFrameAt = now; }

/** The page's look in stream mode: only the canvas, the name tags and their spoken lines, and the label. */
export const STREAM_CSS = `
html.souls-stream,html.souls-stream body{margin:0;overflow:hidden!important;background:#000!important}
html.souls-stream *{cursor:none!important}
html.souls-stream body *{visibility:hidden!important}
html.souls-stream .world-scene .world-viewport{position:fixed!important;inset:0!important;width:auto!important;height:auto!important;border-radius:0!important;z-index:0!important}
html.souls-stream .world-scene .world-canvas-host:not([style*="visibility: hidden"]) canvas,
html.souls-stream .world-scene .world-name-tag,html.souls-stream .world-scene .world-name-tag *,
html.souls-stream .souls-stream-label{visibility:visible!important}
html.souls-stream .souls-stream-label{position:fixed;right:14px;bottom:10px;z-index:2147483000;pointer-events:none;
 font:500 12px/1 system-ui,sans-serif;letter-spacing:.02em;color:rgba(255,255,255,.62);text-shadow:0 1px 3px rgba(0,0,0,.55)}
`;

/** The label's text: `<world name> · soul.game`. */
export const streamLabelText = (worldName: string) => `${worldName.trim() || 'A world'} · soul.game`;

let started = false, label: HTMLElement | null = null;
/** Turns this page into the stream feed (once), and sets the label to this world's name. */
export function startStreamMode(worldName: string) {
  if (!started) {
    started = true;
    lockInput(window);
    (window as unknown as { __soulsStream?: StreamHealth }).__soulsStream = streamHealth;
    const style = document.createElement('style'); style.dataset.soulsStream = ''; style.textContent = STREAM_CSS;
    document.head.append(style); document.documentElement.classList.add('souls-stream');
    label = document.createElement('div'); label.className = 'souls-stream-label'; label.setAttribute('aria-hidden', 'true');
    document.body.append(label);
    const sound = () => (window as unknown as { __edenSound?: { startNow?: () => void } }).__edenSound?.startNow?.();
    sound(); setInterval(sound, 2000);  // the sound layer loads with the world; a suspended context wakes within 2 s
  }
  if (label) label.textContent = streamLabelText(worldName);
}

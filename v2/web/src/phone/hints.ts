// First-touch hints (0.131 parity C3, #3675; today's apps/web/src/touch/hints.tsx): on a touch screen, the first touch of
// a page (once per device) shows the page's gestures: one finger looks around, two fingers pinch to zoom and drag to
// pan, a tap on a Soul follows it and a sideways flick goes to the next. They stay readable for HINT_MIN_MS whatever the
// person does, then their next touch (a tap anywhere, a drag, a second finger) dismisses them, or they fade by themselves
// at HINT_MS (`hintFadeAt`). The device remembers them once they have been readable (localStorage HINT_KEY); with no storage they
// show once per page. Once faded the hints leave the page and their listeners are gone.
import { HINT_DRAG_PX, HINT_FADE_MS, HINT_KEY, HINT_MIN_MS, hintFadeAt, hintsAllowed } from './touch.ts';

const remembered = () => { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } };
const remember = () => { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* they show once per page */ } };

const svg = (body: string) => `<svg viewBox="0 0 48 48" aria-hidden="true" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const GLYPHS: [string, string][] = [
  [svg('<circle cx="17" cy="30" r="6" fill="currentColor" stroke="none"/><path d="M24 30h17M36 25l5 5-5 5"/><path d="M8 30h3" opacity=".5"/>'), 'One finger: look around'],
  [svg('<circle cx="15" cy="33" r="5.5" fill="currentColor" stroke="none"/><circle cx="33" cy="15" r="5.5" fill="currentColor" stroke="none"/><path d="M11 37l-6 6M37 11l6-6M5 37v6h6M37 5h6v6"/>'), 'Two fingers: pinch to zoom, drag to pan'],
  [svg('<circle cx="24" cy="14" r="6"/><path d="M14 40c0-7 4-12 10-12s10 5 10 12"/><path d="M4 26l-2 4 2 4M44 26l2 4-2 4"/>'), 'Tap a Soul to follow; flick sideways for the next'],
];

/** Installs the hints on this page: they wait for its first touch. `nowMs` is the page clock (tests may pass their own). */
export function touchHints(nowMs: () => number = () => performance.now()): void {
  const coarse = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  if (!hintsAllowed({ search: location.search, webdriver: navigator.webdriver === true, coarse, seen: remembered() })) return;
  let first: { id: number; x: number; y: number } | null = null, shownAt = 0, timer = 0, el: HTMLElement | null = null;
  const opts = { capture: true, passive: true } as const;
  const stop = () => { removeEventListener('pointerdown', down, opts); removeEventListener('pointermove', move, opts); clearTimeout(timer); };
  const fade = () => {
    stop();
    if (!el) return;
    const gone = el;
    gone.dataset.phase = 'fading';
    gone.style.opacity = '0';
    setTimeout(() => gone.remove(), HINT_FADE_MS);
  };
  const fadeAt = (ms: number) => { clearTimeout(timer); timer = window.setTimeout(fade, Math.max(0, shownAt + ms - nowMs())); };
  const gesture = () => { removeEventListener('pointermove', move, opts); fadeAt(hintFadeAt(nowMs() - shownAt)); };
  function down(e: PointerEvent) {
    if (e.pointerType !== 'touch') return;
    // A second finger, or a tap once they have been read.
    if (first) { if (e.pointerId !== first.id || nowMs() - shownAt >= HINT_MIN_MS) gesture(); return; }
    first = { id: e.pointerId, x: e.clientX, y: e.clientY };
    shownAt = nowMs();
    el = show();
    setTimeout(remember, HINT_MIN_MS);
    addEventListener('pointermove', move, opts);
    fadeAt(hintFadeAt(null));
  }
  function move(e: PointerEvent) {
    if (!first || e.pointerType !== 'touch') return;
    if (e.pointerId !== first.id || Math.hypot(e.clientX - first.x, e.clientY - first.y) > HINT_DRAG_PX) gesture();
  }
  addEventListener('pointerdown', down, opts);
}

function show(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'touch-hints';
  el.dataset.phase = 'shown';
  el.setAttribute('role', 'note');
  el.setAttribute('aria-label', 'Touch controls');
  const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  el.style.cssText = 'position:fixed;z-index:30;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;gap:10px;padding:14px 12px;'
    + 'max-width:calc(100vw - 32px);box-sizing:border-box;border-radius:18px;background:rgba(16,20,26,0.88);color:#e8e6e1;'
    + `box-shadow:0 6px 28px #0003;pointer-events:none;font:500 12px/1.25 system-ui,sans-serif;${reduced ? '' : 'transition:opacity .4s ease;'}`;
  for (const [glyph, words] of GLYPHS) {
    const f = document.createElement('figure');
    f.style.cssText = 'margin:0;display:flex;flex-direction:column;align-items:center;gap:6px;width:92px;text-align:center';
    f.innerHTML = `${glyph}<figcaption></figcaption>`;
    f.querySelector('figcaption')!.textContent = words;
    el.append(f);
  }
  document.body.append(el);
  return el;
}

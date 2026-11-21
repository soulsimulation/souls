// 0.131 parity C1 (#3673): the world page's screen. Carried over from today's apps/web (wake-lock.ts, fullscreen.ts,
// FullscreenToggle.tsx) by copying; nothing is imported from today's app.
//
// - Wake lock (#1390 today): while the page is visible it holds a screen wake lock, lets it go when the tab is hidden or
//   the page is left, and asks again when shown. After IDLE_MS with no input it lets go, so a forgotten phone still
//   sleeps; the next input asks again. Where the API is missing or the request is refused (battery saver) it does nothing.
// - Fullscreen: today offers it on Android only and hides it once full screen. Here it is a toggle wherever the
//   browser has the Fullscreen API (desktop, Android, iPad), entering and leaving; hidden where there is none (iPhone)
//   and when the page already runs as an installed app.

export const IDLE_MS = 30 * 60_000;
const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

type Sentinel = { released?: boolean; release(): Promise<void>; addEventListener(type: 'release', fn: () => void): void };
type Listen = { addEventListener(type: string, fn: () => void, o?: AddEventListenerOptions): void; removeEventListener(type: string, fn: () => void, o?: EventListenerOptions): void };
export type WakeEnv = {
  wakeLock?: { request(type: 'screen'): Promise<Sentinel> } | null;
  doc: Listen & { visibilityState: string };
  win: Listen;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
};

/** Holds the screen awake by `env`'s rules above; `held()` reads the state, `stop()` lets go for good. */
export function keepAwake(env: WakeEnv, idleMs = IDLE_MS): { held(): boolean; idle(): boolean; stop(): void } {
  const api = env.wakeLock;
  if (!api || typeof api.request !== 'function') return { held: () => false, idle: () => false, stop: () => {} };
  let lock: Sentinel | null = null, asking = false, idle = false, stopped = false, timer: unknown = null;
  const opts = { capture: true, passive: true } as const;
  const visible = () => env.doc.visibilityState === 'visible';
  const acquire = () => {
    if (lock || asking || idle || stopped || !visible()) return;
    asking = true;
    api.request('screen').then((s) => {
      asking = false;
      if (stopped || idle || !visible()) return void s.release().catch(() => {});
      lock = s;
      s.addEventListener('release', () => { if (lock === s) lock = null; }); // the system can drop it too
    }, () => { asking = false; }); // refused: stay quiet, try again on the next show or input
  };
  const release = () => { const s = lock; lock = null; if (s && !s.released) void s.release().catch(() => {}); };
  const arm = () => { if (timer != null) env.clearTimeout(timer); timer = env.setTimeout(() => { timer = null; idle = true; release(); }, idleMs); };
  const onInput = () => { idle = false; arm(); acquire(); };
  const onVisibility = () => { if (visible()) { idle = false; arm(); acquire(); } else release(); };
  env.doc.addEventListener('visibilitychange', onVisibility);
  for (const ev of INPUTS) env.win.addEventListener(ev, onInput, opts);
  arm(); acquire();
  return {
    held: () => !!lock, idle: () => idle,
    stop: () => {
      stopped = true; release(); if (timer != null) env.clearTimeout(timer);
      env.doc.removeEventListener('visibilitychange', onVisibility);
      for (const ev of INPUTS) env.win.removeEventListener(ev, onInput, opts);
    },
  };
}

/** The browser's own: held from now until the page is left (pagehide); a page restored from the back-forward cache
 *  (pageshow, persisted) asks again. `globalThis.v2awake.held()` reads it (proof, tests). */
export function startWakeLock(g: typeof globalThis = globalThis): void {
  const nav = g.navigator as Navigator & { wakeLock?: WakeEnv['wakeLock'] };
  if (!nav?.wakeLock) return;
  let k: ReturnType<typeof keepAwake> | null = null;
  const start = () => {
    k?.stop();
    k = keepAwake({ wakeLock: nav.wakeLock, doc: g.document, win: g, setTimeout: (f, ms) => g.setTimeout(f, ms), clearTimeout: (t) => g.clearTimeout(t as number) });
  };
  g.addEventListener('pagehide', () => k?.stop());
  g.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) start(); });
  start();
  Object.assign(g, { v2awake: { held: () => k?.held() ?? false, idle: () => k?.idle() ?? false } });
}

export type FullscreenEnv = {
  /** document.fullscreenEnabled and a requestFullscreen function on <html> */
  api: boolean;
  /** (display-mode: standalone) or (display-mode: fullscreen), or iOS's navigator.standalone */
  installed: boolean;
  /** document.fullscreenElement is set */
  fullscreen: boolean;
};

/** What the button shows now: nothing, enter or leave. */
export function fullscreenOffer(e: FullscreenEnv): 'none' | 'enter' | 'leave' {
  if (!e.api || (e.installed && !e.fullscreen)) return 'none';
  return e.fullscreen ? 'leave' : 'enter';
}

const APP_MODES = ['(display-mode: standalone)', '(display-mode: fullscreen)'];
const ICON = {
  enter: 'M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4',
  leave: 'M7.5 3.5v4h-4M16.5 7.5h-4v-4M12.5 16.5v-4h4M3.5 12.5h4v4',
};

function readEnv(d: Document): FullscreenEnv {
  const n = navigator as Navigator & { standalone?: boolean };
  return {
    api: d.fullscreenEnabled === true && typeof d.documentElement.requestFullscreen === 'function',
    installed: APP_MODES.some((q) => matchMedia(q).matches) || n.standalone === true,
    fullscreen: !!d.fullscreenElement,
  };
}

/** The Full screen button, first in `bar` (the sound bar, top right). It follows the browser's own fullscreen changes
 *  (Esc, the system back gesture) and the display mode. */
export function mountFullscreen(bar: HTMLElement, d: Document = document): HTMLButtonElement {
  const b = d.createElement('button');
  b.type = 'button';
  b.id = 'fullscreen';
  Object.assign(b.style, { font: '12px system-ui', padding: '4px 6px', opacity: '0.85', lineHeight: '0' });
  const show = () => {
    const offer = fullscreenOffer(readEnv(d));
    b.hidden = offer === 'none';
    if (offer === 'none') return;
    const label = offer === 'enter' ? 'Full screen' : 'Leave full screen';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.dataset.offer = offer;
    b.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="${ICON[offer]}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  };
  b.onclick = (e) => {
    e.stopPropagation();
    // navigationUI 'hide': Android Chrome hides its own bars too; a refusal (no gesture, policy) leaves it as it is.
    if (d.fullscreenElement) void d.exitFullscreen().catch(() => {});
    else void d.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  };
  d.addEventListener('fullscreenchange', show);
  for (const q of APP_MODES) matchMedia(q).addEventListener('change', show);
  show();
  bar.prepend(b);
  return b;
}

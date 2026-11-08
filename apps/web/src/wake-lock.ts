/** #1390: keep a phone's screen awake while someone watches a world. The world page holds a screen wake lock while it is
 *  visible, lets it go when hidden and asks again when shown. After IDLE_MS with no input it lets go, so a forgotten phone
 *  still sleeps, and the next input asks again. Where the API is missing or the request is refused (battery saver), it
 *  does nothing. `window.__soulsWakeLock.held()` reads the state (proof, tests). */
export const IDLE_MS = 30 * 60_000;
const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

type Sentinel = { released?: boolean; release(): Promise<void>; addEventListener(type: 'release', fn: () => void): void };
export type WakeEnv = {
  wakeLock?: { request(type: 'screen'): Promise<Sentinel> } | null;
  doc: { visibilityState: string; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
  win: { addEventListener(type: string, fn: () => void, o?: AddEventListenerOptions): void; removeEventListener(type: string, fn: () => void, o?: EventListenerOptions): void };
  setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void;
};

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
      if (stopped || idle || !visible()) { void s.release().catch(() => {}); return; }
      lock = s; s.addEventListener('release', () => { if (lock === s) lock = null; });   // the system can drop it too
    }, () => { asking = false; });   // refused (battery saver, not allowed): stay quiet, try again on the next show or input
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

/** The browser's own: a world page calls this on mount and the returned function on unmount. */
export function startWakeLock(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const nav = navigator as Navigator & { wakeLock?: WakeEnv['wakeLock'] };
  const k = keepAwake({ wakeLock: nav.wakeLock ?? null, doc: document, win: window, setTimeout: (f, ms) => window.setTimeout(f, ms), clearTimeout: (t) => window.clearTimeout(t as number) });
  (window as unknown as { __soulsWakeLock?: unknown }).__soulsWakeLock = { held: k.held, idle: k.idle };
  return k.stop;
}

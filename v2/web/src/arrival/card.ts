// Today's arrival card on the v2 page (#3780; apps/web ArrivalLight.tsx, #1166, #1318): black with the world's name and
// a white light that grows as the stream comes in, then dissolves into the first drawn frame. It ends at its largest with
// the corners light grey, never a white screen; a `?shot` page never shows it; a failed load shows the reason in place
// of the light. The light is a CSS disc whose growth is a compositor transition, so the card needs no frame of its own,
// and once it has dissolved it is taken out of the page with no timer left behind.

/** How far the load has come at each step the page sees: the stream's pointer, its snapshot, its first part, and the
 *  first drawn frame. The page counts as begun when the card is mounted. */
export type Stage = 'begun' | 'pointer' | 'snapshot' | 'part' | 'drawn';
export const STAGES: Record<Stage, number> = { begun: 0.12, pointer: 0.35, snapshot: 0.7, part: 0.88, drawn: 1 };
/** As today's (arrival-light.ts): the dissolve's length, and how long the light takes to grow toward each new step. */
export const DISSOLVE_MS = 2000, GROW_MS = 2400, FILL_MS = 1200;
/** The disc's solid radius at scale 1, in CSS pixels; the light starts at START of the radius that covers the text and at
 *  full reaches PEAK of the way to the corners, so it never whites out (#1318). */
export const DISC_RADIUS = 146, START = 0.33, PEAK = 0.6, TEXT_MARGIN = 20;
/** Today's growth curve: slow at first, flooding outward at the end, a little linear growth so the start still moves. */
export const growth = (phase: number) => { const e = Math.min(1, Math.max(0, phase)); return 0.15 * e + 0.85 * e * e * e; };
/** The light's solid radius at `phase`, in CSS pixels, on a `width` × `height` page with text `textHalf` px from its centre. */
export const lightRadius = (phase: number, width: number, height: number, textHalf: number) =>
  START * textHalf + (PEAK * Math.hypot(width, height) / 2 - START * textHalf) * growth(phase);

export type Arrival = { phase: number; state: 'loading' | 'failed' | 'dissolving' | 'gone'; reason: string };
export type Event = { t: 'stage'; stage: Stage } | { t: 'fail'; reason: string } | { t: 'gone' };

/** The card's next state. The light only grows; a failure before the first frame replaces the light with its reason, and
 *  a frame drawn later still dissolves the card; once dissolving, nothing but `gone` changes it. */
export function next(a: Arrival, e: Event): Arrival {
  if (a.state === 'gone') return a;
  if (e.t === 'gone') return a.state === 'dissolving' ? { ...a, state: 'gone' } : a;
  if (a.state === 'dissolving') return a;
  if (e.t === 'fail') return { ...a, state: 'failed', reason: e.reason.replace(/^Error: /, '') || 'the world could not be loaded' };
  const phase = Math.max(a.phase, STAGES[e.stage]);
  if (e.stage === 'drawn') return { phase, state: 'dissolving', reason: '' };
  return phase === a.phase ? a : { ...a, phase };
}

const CSS = `
#arrival{position:fixed;inset:0;z-index:2147480001;display:grid;place-items:center;padding:16px;overflow:hidden;pointer-events:none;background:#000;color:#000;font:15px/1.5 system-ui,sans-serif}
#arrival[data-state="dissolving"]{opacity:0;transition:opacity ${DISSOLVE_MS}ms ease}
#arrival .arrival-disc{--s:.33;position:absolute;left:50%;top:50%;width:calc(${DISC_RADIUS}px*2/.31);aspect-ratio:1;transform:translate(-50%,-50%) scale(var(--s));border-radius:50%;background:radial-gradient(circle closest-side,#fff 31%,rgba(255,246,236,.64) 41%,rgba(255,242,230,.42) 51%,rgba(255,238,222,.27) 60%,rgba(255,238,222,.08) 78%,transparent);will-change:transform;transition:transform ${GROW_MS}ms cubic-bezier(.25,.1,.25,1)}
#arrival[data-state="dissolving"] .arrival-disc{transition:transform ${FILL_MS}ms cubic-bezier(.55,.055,.675,.19)}
#arrival .arrival-text{position:relative;display:grid;gap:10px;width:min(240px,70vw);text-align:center}
#arrival .arrival-title{margin:0;font-weight:650;font-size:17px;letter-spacing:-.005em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#arrival progress{-webkit-appearance:none;appearance:none;width:100%;height:4px;border:0;border-radius:2px;overflow:hidden;background:rgba(0,0,0,.16)}
#arrival progress::-webkit-progress-bar{background:transparent}
#arrival progress::-webkit-progress-value{background:#000;border-radius:2px;transition:width ${GROW_MS}ms ease}
#arrival progress::-moz-progress-bar{background:#000;border-radius:2px}
#arrival[data-state="failed"] .arrival-disc,#arrival[data-state="failed"] progress{display:none}
#arrival[data-state="failed"]{color:#e8e6e1}
#arrival .arrival-reason{margin:0;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
#arrival .arrival-reason:empty{display:none}
`;

export type ArrivalCard = { reach(stage: Stage): void; fail(reason: string): void; readonly state: Arrival['state'] };

/** Mounts the card over the page, titled `title`, unless `shot`; returns what the page calls as the load goes on. */
export function mountArrival(doc: Document, title: string, shot: boolean, later: (f: () => void, ms: number) => unknown = (f, ms) => setTimeout(f, ms)): ArrivalCard {
  let a: Arrival = { phase: 0, state: 'loading', reason: '' };
  if (shot) return { reach() {}, fail() {}, get state() { return 'gone' as const; } };
  const style = Object.assign(doc.createElement('style'), { textContent: CSS });
  const root = Object.assign(doc.createElement('div'), { id: 'arrival' });
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  const disc = Object.assign(doc.createElement('div'), { className: 'arrival-disc' });
  disc.setAttribute('aria-hidden', 'true');
  const text = Object.assign(doc.createElement('div'), { className: 'arrival-text' });
  const name = Object.assign(doc.createElement('p'), { className: 'arrival-title', textContent: title });
  const bar = Object.assign(doc.createElement('progress'), { max: 1000, value: 0 });
  bar.setAttribute('aria-label', 'World loading progress');
  const reason = Object.assign(doc.createElement('p'), { className: 'arrival-reason' });
  text.append(name, bar, reason);
  root.append(disc, text);
  doc.head.append(style);
  doc.body.append(root);
  const show = () => {
    root.dataset.state = a.state;
    reason.textContent = a.reason; // plain text, never markup
    const w = root.clientWidth || 1, h = root.clientHeight || 1, box = text.getBoundingClientRect?.();
    const half = (box ? Math.hypot(box.width, box.height) / 2 : 120) + TEXT_MARGIN;
    disc.style.setProperty('--s', String(lightRadius(a.phase, w, h, half) / DISC_RADIUS));
    bar.value = Math.round(a.phase * 1000);
  };
  const go = (e: Event) => {
    const was = a.state, b = next(a, e);
    if (b === a) return; // nothing changed: no work, so parts arriving later cost nothing
    a = b;
    if (a.state === 'gone') {
      root.remove();
      style.remove();
      return;
    }
    show();
    if (a.state === 'dissolving' && was !== 'dissolving') later(() => go({ t: 'gone' }), DISSOLVE_MS);
  };
  go({ t: 'stage', stage: 'begun' });
  return {
    reach: (stage) => go({ t: 'stage', stage }),
    fail: (r) => go({ t: 'fail', reason: r }),
    get state() { return a.state; },
  };
}

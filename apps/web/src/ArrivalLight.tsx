import { useEffect, useLayoutEffect, useRef } from 'react';
import { DISC_RADIUS, DISSOLVE_MS, FRAME_MS, TEXT_MARGIN, fillMs, lightRadius, startClock, tickClock, lightScale, startLight, type Light } from './arrival-light.ts';

/** #1166: black, with the world's name and a bar on a white light that grows with the download, then dissolves into the
 *  world. The last of the light is a compositor transition on the disc, started the moment the work is done: the world's
 *  preparation can hold the main thread for seconds then, and frames would stop with it. #1318: it ends at its largest
 *  radius with the corners light grey, never a white screen. `done` means the world is drawn; the dissolve needs that and
 *  the last bloom begun, and runs while the light is still growing, so a ready world never waits for the animation.
 *  `instant` (a ?shot page) never dissolves, so a
 *  picture is never taken through it. */
export function ArrivalLight({ title, progress, done, card, instant, onGone }: { title: string; progress: number | null; done: boolean; card: boolean; instant: boolean; onGone: () => void }) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), disc = useRef<HTMLDivElement>(null), text = useRef<HTMLDivElement>(null), bar = useRef<HTMLProgressElement>(null);
  const live = useRef({ progress, done, onGone }); live.current = { progress, done, onGone };
  const run = useRef<{ fill(): void; settle(): void } | null>(null);
  // the bar starts where the first paint's boot light left it (the light does too), never back at zero
  const bootValue = useRef(document.querySelector<HTMLProgressElement>('#boot-arrival progress')?.value ?? 0).current;
  useEffect(() => {
    const frame = root.current, picture = canvas.current, plain = disc.current, words = text.current;
    if (!frame || !picture || !plain || !words || instant) return;
    // #1266: from where the first paint's boot light got to, so the light never shrinks back; the clock catches up with the work from there
    let light: Light | null = null, raf = 0, fillTimer = 0, goneTimer = 0, fraction = Math.min(1, (document.querySelector<HTMLProgressElement>('#boot-arrival progress')?.value ?? 0) / 1000), last = 0, drawn = false, filling = false, dissolving = false, fillFrom = 0, fillStart = 0, fillFor = 1;
    light = startLight(picture, () => { light = null; picture.hidden = true; plain.hidden = false; });
    if (!light) picture.hidden = true;
    const still = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
    const first = performance.now();
    // the page has been loading since navigation: that time counts toward judging how long the whole load takes
    let clock = startClock(fraction, first / 1000);
    const size = () => { const box = words.getBoundingClientRect(); return { w: frame.clientWidth, h: frame.clientHeight, half: Math.hypot(box.width, box.height) / 2 + TEXT_MARGIN }; };
    const stopLight = () => { cancelAnimationFrame(raf); raf = 0; light?.stop(); light = null; };
    // A drawn world is never held back for the light: once the last bloom has begun and the world is drawn, the card
    // dissolves while the light is still flooding outward, so the world appears as the light reaches it.
    const settle = () => {
      if (!filling || dissolving || !live.current.done) return;
      dissolving = true; frame.dataset.dissolving = 'true';
      goneTimer = window.setTimeout(() => live.current.onGone(), DISSOLVE_MS);
    };
    const fill = () => {
      if (filling) return; filling = true;
      const { w, h, half } = size();
      // from where the light is now, on the compositor: nothing after this needs the main thread to reach its largest
      plain.hidden = false; plain.style.setProperty('--s', String(lightRadius(fraction, w, h, half) / DISC_RADIUS)); void plain.offsetWidth;
      // the bar finishes with the light (eased in step()), never a jump to full
      const ms = fillMs(fraction); frame.style.setProperty('--fill-ms', ms + 'ms'); fillFrom = fraction; fillStart = performance.now(); fillFor = ms;
      frame.dataset.fill = 'true'; plain.style.setProperty('--s', String(lightRadius(1, w, h, half) / DISC_RADIUS));
      fillTimer = window.setTimeout(() => { stopLight(); if (bar.current) bar.current.value = 1000; }, ms);
      settle();
    };
    run.current = { fill, settle };
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (now - last < FRAME_MS) return;
      const seconds = last ? (now - last) / 1000 : 0; last = now;
      clock = tickClock(clock, live.current.progress ?? 0, seconds); fraction = clock.phase;
      // #1266: the bar shows the same eased fraction as the light, so both move gradually together, never ahead of the work
      if (bar.current) {
        const k = filling ? Math.min(1, (now - fillStart) / fillFor) : 0, eased = k * k * (3 - 2 * k);
        bar.current.value = Math.round((filling ? fillFrom + (1 - fillFrom) * eased : fraction) * 1000);
      }
      const { w, h, half } = size(), radius = lightRadius(fraction, w, h, half);
      if (light) { light.draw(lightScale(radius, w, h), still ? 0 : (now - first) / 1000); if (!drawn) { drawn = true; if (!filling) plain.hidden = true; } }
      else plain.style.setProperty('--s', String(radius / DISC_RADIUS));
    };
    raf = requestAnimationFrame(step);
    if ((live.current.progress ?? 0) >= 1 || live.current.done) fill();
    return () => { run.current = null; stopLight(); clearTimeout(fillTimer); clearTimeout(goneTimer); };
  }, [instant]);
  // from the props, not a frame: this commit may be the last the main thread makes for a while
  useLayoutEffect(() => { if ((progress ?? 0) >= 1 || done) run.current?.fill(); if (done) run.current?.settle(); }, [progress, done]);
  useEffect(() => { if (instant && done) onGone(); }, [instant, done, onGone]);
  return <div ref={root} className="viewer-arrival" data-done={!card} role="status" aria-live="polite">
    <canvas ref={canvas} aria-hidden="true" />
    <div ref={disc} className="arrival-disc" aria-hidden="true" />
    <div ref={text} className="arrival-text">
      <p className="viewer-arrival-title">{title}</p>
      <div className="viewer-arrival-progress"><progress ref={bar} aria-label="World loading progress" max={1000} defaultValue={bootValue} /></div>
    </div>
  </div>;
}

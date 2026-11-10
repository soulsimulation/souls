import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISC_RADIUS, FILL_MS, FULL_MS, HOLD, WAIT, fillMs, LEAD, MIN_S, PEAK, SOLID, START, growth, lightRadius, lightScale, startClock, tickClock } from './arrival-light.ts';

/** The light's phase each frame, at 30 fps, for a progress that is a function of seconds. */
const run = (progress: (t: number) => number, seconds: number) => { let c = startClock(); const out: number[] = []; for (let i = 1; i <= seconds * 30; i++) out.push((c = tickClock(c, progress(i / 30), 1 / 30)).phase); return out; };
const accel = (steps: number[]) => steps.slice(2).map((f, i) => Math.abs((f - steps[i + 1]) - (steps[i + 1] - steps[i])) * 900);

test('a lumpy progress bar gives one continuous bloom: no steps, the speed only bends gently', () => {
  const lumps = [0.05, 0.1, 0.1, 0.35, 0.4, 0.4, 0.42, 0.6, 0.62, 0.8, 0.82, 0.95];
  const steps = run(t => lumps[Math.floor(t)] ?? 1, 12);
  assert.ok(Math.max(...accel(steps)) < 2.5, `largest change of speed ${Math.max(...accel(steps)).toFixed(2)}/s²`);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= steps[i - 1], `it never shrinks (${i})`);
  assert.ok(steps.at(-1)! > 0.85, `it is nearly there when the work is (${steps.at(-1)})`);
});

test('a small world does not wait on the light: by the time its load is done the light is under way, not finished', () => {
  const steps = run(t => (t < 0.3 ? 0.1 : t < 0.8 ? 0.5 : t < 1.6 ? 0.85 : 1), 1.6);
  assert.ok(steps.at(-1)! > 0.15 && steps.at(-1)! < 0.6, String(steps.at(-1)));   // the fill (FILL_MS) finishes it from here
  assert.ok(MIN_S <= 3);
});

test('a pause in the download slows it but never freezes it with a jolt, and it never runs far ahead of the work', () => {
  const steps = run(t => (t < 2 ? 0.2 * t : 0.4), 10);
  assert.ok(steps.every(f => f <= 0.4 + LEAD + 1e-9), String(Math.max(...steps)));
  assert.ok(Math.max(...accel(steps)) < 1, 'it eases to a stop');
  assert.ok(steps.every(f => f <= HOLD));
});

test('the last of the light blooms for its share of the whole way, never a snap, never long', () => {
  assert.equal(fillMs(0), FULL_MS); assert.equal(fillMs(1), FILL_MS); assert.ok(fillMs(0.14) > 2000 && fillMs(0.14) <= FULL_MS);
});

test('a long wake with no progress still lets the light creep, gently', () => {
  const steps = run(() => 0.02, 20);
  assert.ok(steps.at(-1)! > 0.3 && steps.at(-1)! <= WAIT, String(steps.at(-1)));
  assert.ok(Math.max(...accel(steps)) < 1);
});

test('a stalled frame never jumps it', () => {
  const c = tickClock(startClock(), 1, 30);
  assert.ok(c.phase < 0.2, String(c.phase));
});

test('it blooms slowly and floods at the end, like the reference white-out', () => {
  assert.equal(growth(0), 0); assert.equal(growth(1), 1);
  assert.ok(growth(0.5) < 0.2, 'half the time, under a fifth of the growth');
  for (let f = 0.05; f <= 1; f += 0.05) assert.ok(growth(f) > growth(f - 0.05));
});

test('#1318: it runs from 33% of just covering the text to 60% of the way to the corners, on any aspect ratio', () => {
  assert.equal(START, 0.33); assert.equal(PEAK, 0.6);
  for (const [w, h] of [[1920, 1080], [390, 844], [844, 390], [1000, 1000], [320, 1400]]) {
    assert.ok(Math.abs(lightRadius(0, w, h, 140) - 0.33 * 140) < 1e-9);
    const corner = Math.hypot(w, h) / 2;
    assert.ok(Math.abs(lightRadius(1, w, h, 140) - 0.6 * corner) < 1e-9);
    for (let f = 0.1; f <= 1; f += 0.1) assert.ok(lightRadius(f, w, h, 140) > lightRadius(f - 0.1, w, h, 140), 'it only grows');
    const peak = lightRadius(1, w, h, 140);
    assert.ok(Math.abs(lightScale(peak, w, h) * SOLID * Math.min(w, h) - peak) < 1e-9, 'the shader\'s solid part is that radius');
  }
});

test('#1318: no path turns the screen white: the dissolve starts from the light, corners grey', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8'), css = readFileSync(new URL('./world-chrome.css', import.meta.url), 'utf8');
  const view = readFileSync(new URL('./ArrivalLight.tsx', import.meta.url), 'utf8'), boot = readFileSync(new URL('./boot-light.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /data-white|\.viewer-arrival\[[^\]]*\]\{background:#fff/);
  assert.doesNotMatch(html + view, /dataset\.white/);
  assert.match(html, /\.3\*Math\.hypot\(innerWidth,innerHeight\)\/146/, 'the boot light ends at 60% of the corners, as the app\'s does');
  assert.match(html, /48\.18\+/, 'and starts at 33% of the disc radius'); assert.ok(Math.abs(START * DISC_RADIUS - 48.18) < 1e-9);
  assert.match(boot, /START = 0\.33, PEAK = 0\.6/);
  assert.match(css, /\.arrival-disc\{--s:\.33;/);
  assert.match(css, /\[data-fill="true"\] canvas\{opacity:0;transition:opacity calc\(var\(--fill-ms,1\.2s\)/, 'the shader hands over to the disc, so every path ends on one picture');
});

test('first paint is the same picture: black, the disc and the words, and no card', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8'), css = readFileSync(new URL('./world-chrome.css', import.meta.url), 'utf8');
  assert.match(html, /class="arrival-disc"/); assert.doesNotMatch(html, /Loading the world|%'/, '#1266: the name and the bar, no other words');
  assert.doesNotMatch(html, /viewer-arrival-card|viewer-arrival-spinner|Arriving/);
  assert.match(html, /early-world-poster[\s\S]*dataset\.fill/, 'a phone\'s poster does not wait for the app\'s code: the boot light finishes the arrival');
  assert.match(html, /worldName[\s\S]*textContent=n/, 'it names the world from the page, as text, and nothing else');
  assert.match(html, /__simCodeBytes[\s\S]*getEntriesByType\('resource'\)/, '#1266: the code share is counted in bytes from the first paint');
  assert.match(css, /\.viewer-arrival\{[^}]*background:#000/);
});

test('the light sits above the early poster, or a phone never sees it', () => {
  const css = readFileSync(new URL('./world-chrome.css', import.meta.url), 'utf8'), early = readFileSync(new URL('./early-render.ts', import.meta.url), 'utf8');
  const poster = Number(/zIndex: '(\d+)'/.exec(early)?.[1]), light = Number(/\.viewer-arrival\{[^}]*z-index:(\d+)/.exec(css)?.[1]);
  assert.ok(poster > 0 && light > poster, `${light} over ${poster}`);
});

test('the end of the light does not need frames: it starts from the props, on a compositor transition (#1166 review)', () => {
  const css = readFileSync(new URL('./world-chrome.css', import.meta.url), 'utf8'), view = readFileSync(new URL('./ArrivalLight.tsx', import.meta.url), 'utf8');
  assert.match(css, /\[data-fill="true"\] \.arrival-disc\{transition:transform var\(--fill-ms,1\.2s\) cubic-bezier\(\.55,\.055,\.675,\.19\)/); assert.equal(FILL_MS, 1200);
  assert.match(css, /\.arrival-disc\{[^}]*will-change:transform/);
  assert.match(css, new RegExp(`width:calc\\(${DISC_RADIUS}px\\*2/\\.31\\).*#fff 31%`));
  assert.match(view, /useLayoutEffect\(\(\) => \{ if \(\(progress \?\? 0\) >= 1 \|\| done\) run\.current\?\.fill\(\)/);
  const step = view.slice(view.indexOf('const step ='), view.indexOf('raf = requestAnimationFrame(step);\n    if'));
  assert.doesNotMatch(step, /fill\(\)|settle\(\)|dataset/, 'the frame loop only draws');
});

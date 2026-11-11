#!/usr/bin/env node
// record.mjs — record one uncut, real-speed Playwright clip of a journey, then (when ffmpeg is present) burn in a
// scrub bar and a timecode and write an mp4. Never edits, speeds up or cuts the recording.
//
//   node .claude/skills/proof/record.mjs --url <url> --out <file.mp4> [--viewport desktop|phone]
//        [--max-seconds N] [--steps <file.mjs>] [--settle-seconds N] [--from-load] [--time-of-day <h|HH:MM|keep>]
//        [--preset pr-proof|social-landscape|social-portrait|highlight] [--fps N] [--quality low|high] [--size WxH]
//        [--aspect landscape|portrait] [--panel on|off] [--panel-log <file.jsonl>]
//
// --preset (#1644): what the clip is for. pr-proof (the default) is today's output: --viewport desktop (1280x720) or
//          phone (390x844), the recording's own frame rate. social-landscape 1920x1080 and social-portrait 1080x1920 at
//          30 fps; highlight 1280x720 at 30 fps. --fps, --quality (low = 720 short edge, high = 1080), --size and --aspect
//          override the preset. The page is recorded at the output's aspect, so nothing is cropped; --fps repeats or drops
//          frames and never changes speed. tools/proof/clip-presets.mjs has the table.
// --panel on: a debug panel of the Soul↔world exchange (commands →, replies ←, receipt phases •) beside the world in
//          landscape and below it in portrait. The steps log to it with ctx.eden(soulDir, args) or ctx.panel(text);
//          --panel-log adds a JSONL file other processes append ({at: epoch ms, dir, text}). Entries are redacted and
//          the publication check runs on them; a hit fails the take (exit 4). The text is kept in <out>.panel.json.
//
// The clip starts at arrival: the world is on screen and the arrival card is gone, so the take opens on the world
// (one uncut, real-speed take from there; the sidecar's `start` is "arrival" and its `arrived` mark is 0). --from-load
// records from page creation instead, for a journey whose subject is loading or arrival, or a page that is not a world.
// --time-of-day: on a local world URL (127.0.0.1/localhost …/w/<slug>) the world is set to that hour with its clock paused
//          before the page opens (default 12, midday; the god env route as the dev owner, one entry in the world's god
//          history; the clock stays paused afterwards). `keep` leaves the clock alone (use it for god history/undo proofs).
// --arrival-seconds: how long the page may take to arrive before the take starts (default 120). A page that never
//          shows a world fails (exit 1) with a still of where it stuck (<out>.open-failed.png) and a sidecar.
//
// --steps: an ES module whose default export is `async (page, { url, viewport, preset, mark, eden, panel }) => {}`. It
//          drives the journey with real input (page.mouse / page.keyboard / page.touchscreen / locator clicks).
//          `mark('label')` records a chapter time in the sidecar. `await eden(soulDir, ['act', id, params])` runs a Soul CLI
//          command and logs it, its reply and its receipt phases for the debug panel; `panel(text)` logs a note. Without --steps the page is loaded and watched for --settle-seconds.
// --max-seconds: hard cap on the clip. Default: the first `max_seconds:` in docs/process/PROOF-POLICY.yml, else 60.
//          If the journey runs past it the clip is cut at the cap and the script exits 3: shorten the journey.
// With ffmpeg, a thin progress line along the bottom edge and a small timecode chip (drawn by Chromium) at the bottom
// left are burned in. Writes <out> (mp4, or .webm when ffmpeg is missing) and <out>.json (url, viewport, duration, marks, console errors,
// commit). Browsers: PLAYWRIGHT_BROWSERS_PATH when set, else /opt/pw-browsers when present.
// Privacy (#1238): through the take the page's text is polled for its own host and the Reconnect box's wording. A hit
//          goes in the sidecar's `privacy` by kind and second, the take fails (exit 4) and upload.mjs refuses the clip.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hitSummary, readPageText, watchTake } from '../../../tools/proof/clip-privacy.mjs';
import { resolvePlan } from '../../../tools/proof/clip-presets.mjs';
import { finalizePanel, panelHtml, panelLog, panelStates, readPanelFile } from '../../../tools/proof/clip-panel.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function parseArgs(argv) {
  const a = { viewport: 'desktop', settleSeconds: 8, fromLoad: false, timeOfDay: '12', arrivalSeconds: 120 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => { if (i + 1 >= argv.length) throw Error(`${k} needs a value`); return argv[++i]; };
    if (k === '--url') a.url = v();
    else if (k === '--out') a.out = v();
    else if (k === '--viewport') a.viewport = v();
    else if (k === '--max-seconds') a.maxSeconds = Number(v());
    else if (k === '--steps') a.steps = v();
    else if (k === '--settle-seconds') a.settleSeconds = Number(v());
    else if (k === '--from-load') a.fromLoad = true;
    else if (k === '--time-of-day') a.timeOfDay = v();
    else if (k === '--arrival-seconds') a.arrivalSeconds = Number(v());
    else if (k === '--preset') a.preset = v();
    else if (k === '--fps') a.fps = Number(v());
    else if (k === '--quality') a.quality = v();
    else if (k === '--size') a.size = v();
    else if (k === '--aspect') a.aspect = v();
    else if (k === '--panel') { const x = v(); if (!['on', 'off'].includes(x)) throw Error('--panel must be on or off'); a.panel = x; }
    else if (k === '--panel-log') a.panelLog = v();
    else if (k === '-h' || k === '--help') { a.help = true; }
    else throw Error(`unknown arg ${k}`);
  }
  return a;
}

function policyMaxSeconds() {
  try {
    const m = readFileSync(join(ROOT, 'docs/process/PROOF-POLICY.yml'), 'utf8').match(/max_seconds:\s*(\d+)/);
    if (m) return { value: Number(m[1]), from: 'docs/process/PROOF-POLICY.yml' };
  } catch { /* no policy file yet */ }
  return { value: 60, from: 'default' };
}

const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const git = (...args) => { const r = run('git', ['-C', ROOT, ...args]); return r.status === 0 ? r.stdout.trim() : null; };

// Shared with the run cameras (#888): the arrival predicate, mid-page recording and the world-time route.
async function clipTools() {
  const p = (f) => join(ROOT, f);
  if (!existsSync(p('tools/playtest/lib/arrival.mjs'))) return null;
  const [arrival, setup] = await Promise.all([import(pathToFileURL(p('tools/playtest/lib/arrival.mjs')).href), import(pathToFileURL(p('tools/playtest/runs/setup.mjs')).href)]);
  return { ...arrival, ...setup };
}

async function loadChromium() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
  const platform = join(ROOT, 'tools/playtest/lib/platform.mjs');
  if (existsSync(platform)) {
    const p = await import(pathToFileURL(platform).href);
    const pw = p.resolvePlaywright({ serverRoot: ROOT });
    if (pw) return { chromium: pw.chromium, args: p.launchArgs({ gpu: 'swiftshader' }).args, from: pw.from };
  }
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    try { const m = await import(name); const chromium = m.chromium ?? m.default?.chromium; if (chromium) return { chromium, args: ['--enable-unsafe-swiftshader'], from: name }; } catch { /* next */ }
  }
  throw Error('Playwright not found: run `pnpm install --frozen-lockfile` (mars/viewer depends on @playwright/test) or install playwright globally');
}

// The timecode is drawn by Chromium, not ffmpeg's drawtext (#1645): an ffmpeg built without fonts has no drawtext and
// used to leave an empty dark band across the bottom with no timecode in it. One screenshot holds every label in a
// grid (a sprite); ffmpeg's crop picks the cell for each frame's time. The overlay is a small chip at the bottom left
// and a thin progress line along the bottom edge, never a full-width band.
export const TIMECODE = { step: 0.1, cols: 10, maxRows: 400, bandRows: 25, cell: { width: 132, height: 24 }, line: 4, margin: 8 };
const mmss = (sec, tenths) => { const t = Math.max(0, sec), m = Math.floor(t / 60), s = t - m * 60; return `${m}:${(tenths ? s.toFixed(1) : String(Math.floor(s))).padStart(tenths ? 4 : 2, '0')}`; };
/** timecodeLabel(at, total) → "0:07.3 / 0:21" (the clip's time and its whole length). */
export function timecodeLabel(at, total) { return `${mmss(at, true)} / ${mmss(Math.ceil(total), false)}`; }
/** The sprite's layout: one cell per `step` seconds from 0 to the clip's end, in rows of `cols`. A long clip gets a
 *  coarser step so the sprite stays under Chromium's screenshot size. `scale` sizes the chip for larger outputs (#1644):
 *  `css` is the cell in page pixels, `cell` in output pixels. */
export function timecodeSprite(durationSec, o = TIMECODE, scale = 1) {
  let step = o.step; while (Math.ceil(durationSec / step) + 2 > o.cols * o.maxRows) step *= 10;
  const cells = Math.ceil(durationSec / step) + 2, rows = Math.ceil(cells / o.cols);
  const cell = { width: Math.round(o.cell.width * scale), height: Math.round(o.cell.height * scale) };
  return { step, cells, cols: o.cols, rows, scale, css: o.cell, width: o.cols * cell.width, height: rows * cell.height, cell, labels: Array.from({ length: cells }, (_, i) => timecodeLabel(i * step, durationSec)) };
}
/** The ffmpeg filter graph. Inputs: [0:v] the take, then the looped sprite (when drawn), then the panel (when on).
 *  With a panel the take and the panel are stacked first (side by side in landscape, panel below in portrait); the
 *  chip and the progress line go on the whole frame; `fps` (when set) repeats or drops frames, never changes speed. */
export function overlayGraph({ width, durationSec, sprite, panel = null, world = null, fps = null, scale = 1 }, o = TIMECODE) {
  const D = Math.max(durationSec, 0.1).toFixed(2), lineH = Math.max(2, Math.round(o.line * scale)), margin = Math.round(o.margin * scale);
  const line = `color=c=0xffc400:s=${width}x${lineH}:r=25[bar]`, tail = fps ? `,fps=${fps}` : '';
  const progress = `[bar]overlay=x='-w+W*t/${D}':y=H-${lineH}:shortest=1${tail}`;
  const parts = [];
  let src = '[0:v]';
  if (panel) {
    const pin = sprite ? 2 : 1, stack = panel.side === 'right' ? 'hstack' : 'vstack';
    parts.push(`[0:v]scale=${world.width}:${world.height},setsar=1[w]`, `[${pin}:v]fps=25,scale=${panel.width}:${panel.height},setsar=1[p]`, `[w][p]${stack}=inputs=2:shortest=1[s]`);
    src = '[s]';
  }
  if (!sprite) return [...parts, line, `${src}${progress}`].join(';');
  const { cell, cols, step } = sprite, n = `floor(t/${step}+0.0001)`;
  parts.push(`[1:v]crop=w=${cell.width}:h=${cell.height}:x='mod(${n},${cols})*${cell.width}':y='floor(${n}/${cols})*${cell.height}'[tc]`,
    `${src}[tc]overlay=x=${margin}:y=H-h-${lineH + margin}:shortest=1[v]`, line, `[v]${progress}`);
  return parts.join(';');
}

const escHtml = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
/** Render the timecode sprite with a fresh Chromium (a screenshot from the take's browser fails after a long take), in
 *  bands of `bandRows` rows (one tall screenshot fails in headless Chromium), stacked into one PNG by ffmpeg; null when
 *  that fails (the clip keeps the line). */
async function renderTimecodeSprite(launch, dir, durationSec, scale = 1, o = TIMECODE) {
  const sprite = timecodeSprite(durationSec, o, scale), { css, cols } = sprite, per = cols * o.bandRows, bands = [];
  let browser = null;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: cols * css.width, height: o.bandRows * css.height }, deviceScaleFactor: scale });
    for (let i = 0; i < sprite.cells; i += per) {
      const labels = sprite.labels.slice(i, i + per), rows = Math.ceil(labels.length / cols), file = join(dir, `timecode-${bands.length}.png`);
      await page.setContent(`<style>html,body{margin:0;background:transparent}body{display:grid;grid-template-columns:repeat(${cols},${css.width}px);grid-auto-rows:${css.height}px}
        i{font:600 13px/1 ui-monospace,Menlo,Consolas,monospace;font-style:normal;color:#fff;display:flex;align-items:center;justify-content:center;margin:2px;border-radius:5px;background:rgba(0,0,0,.55)}</style>` +
        labels.map((l) => `<i>${escHtml(l)}</i>`).join(''));
      await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: cols * css.width, height: rows * css.height } });
      bands.push(file);
    }
    await browser.close(); browser = null;
    const file = join(dir, 'timecode.png');
    if (bands.length === 1) copyFileSync(bands[0], file);
    else {
      const r = run('ffmpeg', ['-y', '-loglevel', 'error', ...bands.flatMap((f) => ['-i', f]), '-filter_complex', `vstack=inputs=${bands.length}`, '-pix_fmt', 'rgba', file]);
      if (r.status !== 0) throw Error(`stacking the timecode bands failed: ${r.stderr.slice(0, 200)}`);
    }
    return { ...sprite, file };
  } catch (e) { await browser?.close().catch(() => {}); console.error(`warn: timecode not rendered (${String(e?.message ?? e).slice(0, 200)}); the clip keeps its progress line`); return null; }
}

/** concatList(states, files) → an ffconcat script that shows each panel image for its state's duration. */
export function concatList(states, files) {
  const lines = ['ffconcat version 1.0'];
  states.forEach((st, k) => lines.push(`file '${basename(files[k])}'`, `duration ${(st.end - st.start).toFixed(3)}`));
  if (files.length) lines.push(`file '${basename(files.at(-1))}'`);    // the demuxer reads the last duration only with a following file
  return lines.join('\n') + '\n';
}

/** Draw one panel image per state of the exchange and the ffconcat script that times them; throws on failure. */
async function renderPanel(launch, dir, entries, durationSec, plan) {
  const { panel, context } = plan, dsf = context.deviceScaleFactor ?? 1, states = panelStates(entries, durationSec), files = [];
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: Math.round(panel.width / dsf), height: Math.round(panel.height / dsf) }, deviceScaleFactor: dsf });
    for (const [k, st] of states.entries()) {
      const file = join(dir, `panel-${String(k).padStart(4, '0')}.png`);
      await page.setContent(panelHtml(st.shown, { side: panel.side }));
      await page.screenshot({ path: file });
      files.push(file);
    }
  } finally { await browser.close(); }
  const list = join(dir, 'panel.ffconcat');
  writeFileSync(list, concatList(states, files));
  return { list, states: states.length };
}

function burnIn(src, dst, { width, durationSec, sprite, panel = null, plan = null }) {
  const crf = String(plan?.crf ?? 23);
  const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', crf, '-movflags', '+faststart', '-an'];
  const graphOpts = { width, durationSec, panel: panel ? plan.panel : null, world: plan?.world, fps: plan?.fps, scale: plan?.scale ?? 1 };
  for (const s of sprite ? [sprite, null] : [null]) {  // the line alone when the chip cannot be drawn
    const inputs = ['-i', src, ...(s ? ['-loop', '1', '-framerate', '25', '-i', s.file] : []), ...(panel ? ['-f', 'concat', '-safe', '0', '-i', panel.list] : [])];
    for (const codec of [enc, ['-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an']]) {
      const r = run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', overlayGraph({ ...graphOpts, sprite: s }), ...codec, dst]);
      if (r.status === 0) return { ok: true, timecode: !!s };
    }
  }
  return { ok: false };
}

/** worldTimePlan({url, timeOfDay}, tools) → {base, time} to set, or {why} when the clock is left alone. Throws on an
 *  invalid --time-of-day. */
export function worldTimePlan(a, tools) {
  if (a.timeOfDay === 'keep') return { why: 'keep' };
  if (!tools) return { why: 'tools/playtest not in this checkout' };
  const req = tools.worldTimeRequest({ timeOfDay: /^\d+(\.\d+)?$/.test(a.timeOfDay) ? Number(a.timeOfDay) : a.timeOfDay });
  if (req.errors.length) throw Error(`--time-of-day: ${req.errors[0].message.replace('world.timeOfDay ', '')}`);
  const base = tools.worldBase(a.url);
  return base ? { base, time: req.time } : { why: 'not a local world URL' };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.url || !a.out) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 38).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(a.help ? 0 : 2); }
  const clip = resolvePlan(a), vp = clip.context;      // #1644: preset + overrides; pr-proof alone is today's output
  const cap = a.maxSeconds > 0 ? { value: a.maxSeconds, from: '--max-seconds' } : policyMaxSeconds();
  const steps = a.steps ? (await import(pathToFileURL(resolve(a.steps)).href)).default : null;
  if (a.steps && typeof steps !== 'function') throw Error(`${a.steps} must default-export async (page, ctx) => {}`);

  const out = resolve(a.out); mkdirSync(dirname(out), { recursive: true });
  const tools = await clipTools();
  // World time first (#888), before the page opens: a local world is shown at midday with its clock paused.
  const plan = worldTimePlan(a, tools);
  let worldTime = { requested: plan.time ?? a.timeOfDay, applied: false, why: plan.why ?? null };
  if (plan.base) {
    const r = await tools.applyWorldTime({ base: plan.base, time: plan.time, note: 'proof recorder world time (#888)' });
    worldTime = { requested: plan.time, applied: r.ok, ...(r.ok ? { clock: r.applied } : { why: r.error }) };
    if (!r.ok) console.error(`warn: world time not set (${r.error}); the clip shows the world's own clock`);
  }
  const work = mkdtempSync(join(tmpdir(), 'proof-'));
  const { chromium, args, from } = await loadChromium();
  const browser = await chromium.launch({ headless: true, args: [...args, ...(clip.forceScale ? [`--force-device-scale-factor=${clip.forceScale}`] : [])] });
  const { width, height } = clip.world;                // the recorded page, in output pixels
  // Arrival start needs a mid-page recording (page.screencast); without it this Playwright records from page creation.
  let context = await browser.newContext({ ...vp, ...(a.fromLoad ? { recordVideo: { dir: work, size: { width, height } } } : {}) });
  let page = await context.newPage(), startFallback = null;
  if (!a.fromLoad && !tools?.canScreencast(page)) {
    await context.close(); startFallback = tools ? 'page.screencast unavailable in this Playwright: recorded from page creation' : 'tools/playtest not in this checkout: recorded from page creation';
    context = await browser.newContext({ ...vp, recordVideo: { dir: work, size: { width, height } } }); page = await context.newPage();
  }
  const screencast = !a.fromLoad && !startFallback ? join(work, 'arrival.webm') : null;
  let t0 = Date.now(), startedAt = new Date(t0).toISOString();
  const log = panelLog({ since: () => t0, ...(process.env.EDEN ? { eden: resolve(process.env.EDEN) } : {}) });
  const marks = [], consoleErrors = [];
  const mark = (label) => marks.push({ label: String(label), atSec: +((Date.now() - t0) / 1000).toFixed(2) });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e?.message ?? e).slice(0, 500)}`));

  let truncated = false, stepError = null, capTimer = null, watch = null;
  const watchFromHere = () => { watch = watchTake({ read: () => page.evaluate(readPageText), sinceSec: () => (Date.now() - t0) / 1000 }); };
  const capped = new Promise((r) => { capTimer = () => setTimeout(() => { truncated = true; r(); }, cap.value * 1000); });
  const journey = (async () => {
    if (screencast) {
      // Loading is not in the clip: open the page, wait for the world, then start the one take.
      await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: a.arrivalSeconds * 1000 });
      await page.waitForFunction(tools.worldArrived, null, { timeout: a.arrivalSeconds * 1000 })
        .catch(() => { throw Error(`the page never arrived on a world in ${a.arrivalSeconds} s (world on screen, arrival card gone); for a page that is not a world, or a journey about loading, pass --from-load`); });
      ({ startedAt } = await tools.startScreencast(page, { path: screencast, size: { width, height } }));
      t0 = Date.parse(startedAt); capTimer();
      mark('arrived'); watchFromHere();
    } else {
      capTimer();
      mark('goto'); watchFromHere();
      // From load, the arrival is still marked (in the background) so the preview GIF and readers can find it.
      if (tools) page.waitForFunction(tools.worldArrived, null, { timeout: cap.value * 1000 }).then(() => mark('arrived'), () => {});
      await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: cap.value * 1000 });
    }
    if (steps) await steps(page, { url: a.url, viewport: clip.viewport, preset: clip.preset, mark, panel: log.panel, eden: log.eden });
    else await page.waitForTimeout(Math.min(a.settleSeconds, cap.value) * 1000);
    await page.waitForTimeout(800);                    // let the last frame land
  })().catch((e) => { stepError = String(e?.stack ?? e).slice(0, 2000); });
  await Promise.race([journey, capped]);
  if (stepError && screencast && !marks.length) {
    // Never arrived: no take was started. Keep a still of where it stuck and a sidecar saying so.
    const still = `${out.replace(/\.[^./]*$/, '')}.open-failed.png`;
    const shot = await page.screenshot({ path: still, timeout: 15000 }).then(() => basename(still), () => null);
    await context.close(); await browser.close(); rmSync(work, { recursive: true, force: true });
    writeFileSync(`${out}.json`, JSON.stringify({ file: null, url: a.url, viewport: a.viewport, start: 'arrival', startRequested: 'arrival', arrived: false, openFailedShot: shot, worldTime, stepError, consoleErrors,
      commit: git('rev-parse', 'HEAD'), recordedAt: new Date().toISOString() }, null, 2) + '\n');
    console.error(stepError); process.exit(1);
  }
  const durationSec = +((Date.now() - t0) / 1000).toFixed(2);
  log.stop();
  const privacy = await watch.stop();                  // before the recording closes: its last read sees the last frames
  const video = screencast ? null : page.video();
  if (screencast) await page.screencast.stop();
  await context.close();
  const videoSec = (Date.now() - t0) / 1000;           // the recording runs from its start (arrival or page creation) to close
  const raw = screencast ?? await video.path();
  await browser.close();
  const launch = () => chromium.launch({ headless: true, args }), ffmpeg = has('ffmpeg');
  // The debug panel's text: redacted, then the publication check. A hit fails the take before anything is drawn.
  let panelText = null, panel = null;
  if (clip.panel) {
    const rawEntries = [...log.entries, ...(a.panelLog && existsSync(a.panelLog) ? readPanelFile(a.panelLog, t0) : [])];
    panelText = finalizePanel(rawEntries);
    if (panelText.findings.length) privacy.hits.push({ kind: 'panel-text', firstSec: 0, lastSec: +videoSec.toFixed(1), findings: panelText.findings });
    else if (ffmpeg) panel = await renderPanel(launch, work, panelText.entries, videoSec, clip).catch((e) => { console.error(`warn: debug panel not drawn (${String(e?.message ?? e).slice(0, 200)})`); return null; });
  }
  const sprite = ffmpeg && !(panelText?.findings.length) ? await renderTimecodeSprite(launch, work, videoSec, clip.scale) : null;

  let file = out, burned = null;
  if (ffmpeg && !(panelText?.findings.length)) {
    if (extname(out) !== '.mp4') file = out.replace(/\.[^./]*$/, '') + '.mp4';
    burned = burnIn(raw, file, { width: clip.out.width, durationSec: videoSec, sprite, panel, plan: clip });
    if (!burned.ok) { file = file.replace(/\.mp4$/, '.webm'); copyFileSync(raw, file); }
  } else if (!(panelText?.findings.length)) {
    file = out.replace(/\.[^./]*$/, '') + '.webm';
    copyFileSync(raw, file);
  } else file = out.replace(/\.[^./]*$/, '') + '.mp4';   // nothing written: the panel text failed the check
  if (panelText) writeFileSync(`${file}.panel.json`, JSON.stringify({ clip: basename(file), entries: panelText.findings.length ? [] : panelText.entries, findings: panelText.findings }, null, 2) + '\n');
  rmSync(work, { recursive: true, force: true });

  const meta = {
    file: basename(file), url: a.url, viewport: clip.viewport, size: `${clip.out.width}x${clip.out.height}`, durationSec,
    preset: clip.preset, plan: { aspect: clip.aspect, out: clip.out, world: clip.world, css: clip.context.viewport, deviceScaleFactor: clip.context.deviceScaleFactor, fps: clip.fps, crf: clip.crf, panel: clip.panel ? { ...clip.panel, drawn: !!panel, entries: panelText?.entries.length ?? 0 } : null }, videoSec: +videoSec.toFixed(2), maxSeconds: cap.value,
    start: screencast ? 'arrival' : 'load', startRequested: a.fromLoad ? 'load' : 'arrival', ...(startFallback ? { startFallback } : {}), startedAt, worldTime,
    maxSecondsFrom: cap.from, truncated, stepsFile: a.steps ?? null, stepError, marks, consoleErrors, privacy,
    scrubBar: !!burned?.ok, timecode: !!burned?.timecode, playwright: from,
    commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '') !== '', recordedAt: new Date().toISOString(),
  };
  writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log(`${file}  ${durationSec}s ${clip.preset} ${clip.out.width}x${clip.out.height}${clip.fps ? ` ${clip.fps}fps` : ''}${clip.panel ? ` panel ${clip.panel.side}` : ''} from ${meta.start}${meta.scrubBar ? ' +scrub bar' : ' (raw: no ffmpeg or ffmpeg failed)'}  console errors: ${consoleErrors.length}`);
  console.log(`${file}.json`);
  if (privacy.hits.length) { console.error(`privacy: this take showed ${hitSummary(privacy.hits)}; it is failed and upload.mjs refuses it. Fix what showed it and record a new take; never publish this one`); process.exit(4); }
  if (stepError) { console.error(`steps failed: ${stepError}`); process.exit(1); }
  if (truncated) { console.error(`journey ran past ${cap.value}s (${cap.from}); clip cut at the cap: shorten the journey`); process.exit(3); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });

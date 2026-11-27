#!/usr/bin/env node
// 27 Nov (first day): the home page's picture of a world its owner gave none. Before, such a card showed its template's
// default (the empty plain's is bare grass, whatever was built on it since) or, for a template with no default (a world
// made on the new engine from mars-camp), a blank grey card. Now the launcher draws each such world itself, in the
// background, as a visitor's page shows it: the world's own page in shot mode at noon (`?shot=1&hour=12:00`), from
// above and to the south-west of its places (or of the origin, where a new world starts, when the launcher knows none),
// 1280 × 720, a JPEG of about 50–150 KB.
//
// - kept: `<data>/covers/<slug>/cover.json` ({schema: 'world-cover/1', sha, at, eye, look}) beside `<sha>.jpg`; one
//   picture per world, the older one removed when a new one is kept.
// - served: `/__sim/thumbs/<slug>/<sha>.jpg`, public and immutable, like the owner's picture (thumbnail.mjs).
// - made: `node tools/world-launcher/world-covers.mjs --page <world page URL> --out <data>/covers/<slug> --eye x,y,z
//   --at x,y,z`, its own process and headless browser at the lowest CPU priority, by coverKeeper below: one run at a
//   time, never in a world's process or on its clock, a world's picture redrawn after `maxAgeMs` (a day) so it follows
//   what is built there. The owner's own picture always wins (launcher thumbView).
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../lib/is-main.mjs';

const SHA = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const round = (v) => Math.round(v * 10) / 10;

/** Where the camera stands for a world's picture: above and south-west of the middle of its places (`targets`: their
 *  `point` and `radius`), far enough back to hold them all; with none known, the 55 m round the origin a new world
 *  starts in. */
export function coverFraming(targets = []) {
  const known = (targets ?? []).filter((t) => Array.isArray(t?.point) && t.point.length === 3 && t.point.every(Number.isFinite));
  if (!known.length) return { eye: [-60.5, 41.3, 60.5], at: [0, 0, 0] };
  const lo = [0, 2].map((i) => Math.min(...known.map((t) => t.point[i] - (Number(t.radius) || 0))));
  const hi = [0, 2].map((i) => Math.max(...known.map((t) => t.point[i] + (Number(t.radius) || 0))));
  const at = [(lo[0] + hi[0]) / 2, 0, (lo[1] + hi[1]) / 2], span = Math.min(400, Math.max(40, (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2));
  return { eye: [round(at[0] - 1.1 * span), round(0.75 * span), round(at[2] + 1.1 * span)], at: at.map(round) };
}

/** `dir`: `<data>/covers`. → {current(slug), file(slug, sha), due(slug, maxAgeMs, now)}. The index is read again when it
 *  changes (looked at once a second), so a drawing run takes effect without a restart. */
export function worldCovers({ dir }) {
  const cache = new Map();
  const current = (slug, fresh = false) => {
    if (!SLUG.test(slug)) return null;
    const now = Date.now(), c = cache.get(slug);
    if (c && !fresh && now - c.at < 1000) return c.v;
    let v = null;
    try { const j = JSON.parse(readFileSync(join(dir, slug, 'cover.json'), 'utf8')); if (j?.schema === 'world-cover/1' && SHA.test(j.sha ?? '') && existsSync(join(dir, slug, `${j.sha}.jpg`))) v = j; } catch { /* none */ }
    cache.set(slug, { at: now, v });
    return v;
  };
  return {
    /** The kept picture ({sha, at, eye, look}), else null; `fresh`: read now, not within the second. */
    current,
    /** The file of `sha` when it is the world's kept picture, else null (an older one is never served). */
    file: (slug, sha) => (current(slug)?.sha === sha ? join(dir, slug, `${sha}.jpg`) : null),
    /** Whether the world wants drawing: no picture, one older than `maxAgeMs`, or one taken from elsewhere (`eye`/`look`). */
    due: (slug, { maxAgeMs, eye, look, now = Date.now() }) => { const c = current(slug); return !c || now - (c.at ?? 0) > maxAgeMs || String(c.eye) !== String(eye) || String(c.look) !== String(look); },
  };
}

/** The pictures of the worlds with none from their owner, drawn ahead of visitors: looked at `firstMs` after the launcher
 *  starts and every `everyMs` after; one world drawn per run (`run`: this file's CLI, its own process), one run at a time,
 *  none while `canStart()` says no (the host's memory) or `busy()` (another drawing on the host). A world whose run
 *  failed is not tried again for `retryMs`. `worlds()`: [{slug, targets}]; `page(slug)`: its page URL.
 *  → {check(), status(), close()}; `status()` is the gauge (healthz). */
export function coverKeeper({ covers, dir, worlds, page, run = drawCover, log = () => {}, canStart = () => true, busy = () => false, firstMs = 90_000, everyMs = 10 * 60_000, maxAgeMs = 24 * 3600_000, deadlineMs = 5 * 60_000, retryMs = 6 * 3600_000, now = Date.now }) {
  let running = null, closed = false, last = null;
  const failed = new Map();   // slug → when its last run failed
  const check = () => {
    if (closed || running) return running?.done ?? null;
    let list = [];
    try { list = worlds() ?? []; } catch (e) { log(`covers: the worlds could not be listed: ${e.message}`); }
    for (const { slug, targets } of list) {
      const { eye, at } = coverFraming(targets);
      if (!covers.due(slug, { maxAgeMs, eye, look: at, now: now() }) || now() - (failed.get(slug) ?? -Infinity) < retryMs) continue;
      if (!canStart() || busy()) return null;
      const started = now(), stop = new AbortController();
      running = { slug, started, stop: () => stop.abort() };
      running.done = Promise.resolve().then(() => run({ slug, page: page(slug), out: join(dir, slug), eye, at, deadlineMs, signal: stop.signal })).catch((e) => ({ code: null, error: e.message })).then((r) => {
        const kept = r?.code === 0 && covers.current(slug, true)?.at >= started;
        if (kept) failed.delete(slug); else failed.set(slug, now());
        last = { slug, at: new Date(started).toISOString(), ms: now() - started, kept, code: r?.code ?? null, ...(r?.error ? { error: r.error } : {}) };
        log(`covers: ${slug}: ${kept ? 'drawn' : `not drawn (exit ${r?.code ?? r?.error}; log ${join(dir, slug, 'draw.log')})`} in ${Math.round(last.ms / 1000)} s`);
        running = null;
        if (!closed) setImmediate(check);   // the next world, if any
      });
      return running.done;
    }
    return null;
  };
  const first = setTimeout(check, firstMs), timer = setInterval(check, everyMs);
  first.unref?.(); timer.unref?.();
  return {
    check,
    status: () => ({ running: running ? { slug: running.slug, forS: Math.round((now() - running.started) / 1000) } : null, last }),
    close() { closed = true; clearTimeout(first); clearInterval(timer); running?.stop?.(); },
  };
}

/** One drawing: this file's CLI in its own process at the lowest CPU priority, its output in `<out>/draw.log`; SIGTERM at
 *  the deadline or on `signal`, SIGKILL 10 s later. */
export function drawCover({ page, out, eye, at, deadlineMs, signal }) {
  mkdirSync(out, { recursive: true });
  const fd = openSync(join(out, 'draw.log'), 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--page', page, '--out', out, '--eye', eye.join(','), '--at', at.join(','), '--nice', '19'], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  try { if (child.pid) setPriority(child.pid, 19); } catch { /* a host may not allow it: the CLI asks again */ }
  return new Promise((done) => {
    let kill = null;
    const end = () => { if (kill) return; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 10_000); kill.unref?.(); };
    const deadline = setTimeout(end, deadlineMs);
    deadline.unref?.();
    signal?.addEventListener('abort', end, { once: true });
    const settle = (r) => { clearTimeout(deadline); clearTimeout(kill); signal?.removeEventListener('abort', end); done(r); };
    child.once('error', (e) => settle({ code: null, error: e.message }));
    child.once('exit', (code, sig) => settle({ code, signal: sig }));
  });
}

/** Opens the world's page in shot mode at noon with the camera at `eye` looking at `at`, waits until it says it is drawn
 *  (`__shotReady`) and a moment more for late models, and keeps the 1280 × 720 view as `<out>/<sha>.jpg`. */
export async function makeCover({ page, out, eye, at, chromium, args = [], settleMs = 3000, log = () => {} }) {
  const url = new URL(page);
  for (const [k, v] of Object.entries({ shot: '1', hour: '12:00', eye: eye.join(','), at: at.join(',') })) url.searchParams.set(k, v);
  const browser = await chromium.launch({ headless: true, args });
  let bytes;
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await tab.goto(url.href, { waitUntil: 'load', timeout: 300_000 });
    await tab.waitForFunction(() => !!window.__shotReady, null, { timeout: 600_000, polling: 1000 });
    await tab.waitForTimeout(settleMs);
    bytes = await tab.screenshot({ type: 'jpeg', quality: 80 });
  } finally { await browser.close(); }
  const sha = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${sha}.jpg`), bytes);
  writeFileSync(join(out, 'cover.json.tmp'), JSON.stringify({ schema: 'world-cover/1', sha, at: Date.now(), eye, look: at }));
  renameSync(join(out, 'cover.json.tmp'), join(out, 'cover.json'));
  for (const f of readdirSync(out)) if (f.endsWith('.jpg') && f !== `${sha}.jpg`) rmSync(join(out, f), { force: true });
  log(`${url.href}: ${bytes.length} B`);
  return { sha, bytes: bytes.length };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const vec = (s) => { const v = String(s ?? '').split(',').map(Number); return v.length === 3 && v.every(Number.isFinite) ? v : null; };
  const page = opt('page'), out = opt('out'), eye = vec(opt('eye')), at = vec(opt('at')), nice = Number(opt('nice'));
  if (!page || !out || !eye || !at) { console.error('usage: world-covers.mjs --page <world page URL> --out <data>/covers/<slug> --eye x,y,z --at x,y,z [--nice <0-19>]'); process.exit(2); }
  if (Number.isInteger(nice) && nice >= 0 && nice <= 19) try { setPriority(nice); } catch { /* not allowed here */ }
  const { resolvePlaywright, launchArgs, browsersPath } = await import(pathToFileURL(resolve(import.meta.dirname, '../playtest/lib/platform.mjs')).href);
  browsersPath();
  const pw = resolvePlaywright({ serverRoot: resolve(import.meta.dirname, '../..') });
  if (!pw) { console.error('world-covers: Playwright not found (pnpm install --frozen-lockfile)'); process.exit(1); }
  const r = await makeCover({ page: page.endsWith('/') ? page : `${page}/`, out: resolve(out), eye, at, chromium: pw.chromium, args: launchArgs().args, log: (s) => console.error(s) });
  console.log(JSON.stringify(r));
}

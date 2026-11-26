#!/usr/bin/env node
// 25 Nov: Explore's place pictures of a moved world. On the old engine the world's own process rendered each place
// (apps/server god/context-views.ts); a moved world has no old process (D2b, #4612), so every card showed the generic
// house. Now the page draws a place it has no kept picture of (WorldContextViews.ts `draw`, answered `draw: 'page'`),
// and this keeps the pictures published for a world, so a visitor's Explore fills from small immutable files:
//
// - kept: `<data>/place-shots/<slug>/index.json` ({schema: 'place-shots/1', shots: {<ref>: {target, sha, bytes}}})
//   beside `<sha>.webp`. `target` is `targetKey` of the place as the launcher lists it (its point, radius, viewpoint):
//   a place that moved, or a new one, has no kept picture until it is drawn again, and the page draws it meanwhile.
// - served: `/w/<slug>/v1/world/context/shot/<sha>.webp`, public and immutable (its name is its content's hash).
// - made: `node tools/world-launcher/place-shots.mjs --page <world page URL> --out <data>/place-shots/<slug> [--plan]`
//   opens the world's own page headless (`?placeShots=1`, LiveWorld.tsx), has it draw every place of the published
//   snapshot it has no current picture of, and writes them (`--plan`: only counts them). A run with nothing missing
//   draws nothing. For every moved world of soul.game at once, drawn here and copied to the host:
//   tools/world-launcher/deploy/place-shots.sh.
// - made ahead (#5038, 26 Nov): the launcher runs that drawing itself, in the background (placeShotKeeper below), after
//   a release and after a world's places change, so no visitor's first look draws a place.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { snapshotPlaces } from './cutover.mjs';

const SHOT = /^\/v1\/world\/context\/shot\/([0-9a-f]{64})\.webp$/;
const SHA = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** How pictures are drawn (WorldPlacePreviews.ts framing): a new value redraws every kept picture on the next run. */
export const DRAWING = 'place-shots/2';
/** What a place's picture depends on, as the launcher lists it (cutover.mjs snapshotPlaces): where and how it is framed. */
export function targetKey(t) {
  return createHash('sha256').update(JSON.stringify([DRAWING, t.point, t.radius, t.viewpoint ?? null, !!t.enclosed])).digest('hex').slice(0, 32);
}

/** `dir`: `<data>/place-shots`. → {views(slug, refs, places), serve(req, res, slug, rest)}. The index is read again when
 *  its file changes (looked at once a second), so a generator run takes effect without a restart. `log` is told, once per
 *  world and index, how many of its places have no kept picture (the page draws those for each visitor). */
export function placeShots({ dir, log = () => {} }) {
  const cache = new Map(), told = new Map();
  const index = (slug, fresh = false) => {
    if (!SLUG.test(slug)) return null;
    const file = join(dir, slug, 'index.json'), now = Date.now(), c = cache.get(slug);
    if (c && !fresh && now - c.at < 1000) return c.shots;
    let mtime = 0; try { mtime = statSync(file).mtimeMs; } catch { /* none */ }
    if (c && c.mtime === mtime) { c.at = now; return c.shots; }
    let shots = null;
    try { const j = JSON.parse(readFileSync(file, 'utf8')); if (j?.schema === 'place-shots/1' && j.shots && typeof j.shots === 'object') shots = j.shots; } catch { /* none */ }
    cache.set(slug, { at: now, mtime, shots });
    return shots;
  };
  return {
    /** The places (`snapshotPlaces` targets) with no current kept picture: none drawn, moved, or its file gone. */
    missing(slug, targets, fresh = false) { const shots = index(slug, fresh); return targets.filter((t) => { const s = shots?.[t.ref]; return !s || s.target !== targetKey(t) || !SHA.test(s.sha ?? '') || !existsSync(join(dir, slug, `${s.sha}.webp`)); }); },
    /** POST /v1/world/context/views's answer: a kept picture of the place as it is now, else `draw: 'page'`. */
    views(slug, refs, places) {
      const shots = index(slug), byRef = new Map((places ?? []).map((p) => [p.target.ref, p.target]));
      const seen = `${cache.get(slug)?.mtime ?? 0} ${byRef.size}`;
      if (places?.length && told.get(slug) !== seen) {
        told.set(slug, seen);
        const without = [...byRef.values()].filter((t) => shots?.[t.ref]?.target !== targetKey(t)).length;
        if (without) log(`place-shots: ${slug} has ${without} of ${byRef.size} places without a kept picture; the page draws them for each visitor (tools/world-launcher/deploy/place-shots.sh)`);
      }
      return refs.map((ref) => {
        const s = shots?.[ref], t = byRef.get(ref);
        return s && t && SHA.test(s.sha ?? '') && s.target === targetKey(t) ? { ref, status: 'ready', thumb: `/v1/world/context/shot/${s.sha}.webp` } : { ref, status: 'unavailable', draw: 'page' };
      });
    },
    /** The home page's card picture for a world with neither its owner's nor its template's (launcher thumbView): its
     *  fullest kept place picture (the most bytes: the most to see), as the shot route serves it, else null. */
    cover(slug) {
      let best = null;
      for (const s of Object.values(index(slug) ?? {})) if (SHA.test(s?.sha ?? '') && (!best || (s.bytes ?? 0) > (best.bytes ?? 0)) && existsSync(join(dir, slug, `${s.sha}.webp`))) best = s;
      return best ? `/v1/world/context/shot/${best.sha}.webp` : null;
    },
    /** True when `rest` is the shot route (answered: the file, 304 or 404). */
    serve(req, res, slug, rest) {
      const m = SHOT.exec(rest);
      if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
      const file = join(dir, slug, `${m[1]}.webp`);
      if (!SLUG.test(slug) || !existsSync(file)) { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"ok":false,"code":"shot.not-found"}'); return true; }
      const etag = `"${m[1]}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': IMMUTABLE }).end(); return true; }
      res.writeHead(200, { 'content-type': 'image/webp', 'content-length': statSync(file).size, etag, 'cache-control': IMMUTABLE });
      if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
      return true;
    },
  };
}

/** #5038: Explore's pictures of the moved worlds, made ahead of time in the background, so a visitor's Explore fills from
 *  kept files and no first look draws a place. Looked at `firstMs` after the launcher starts (a release) and every
 *  `everyMs` after (a world's published places changed): a world with places that have no current picture
 *  (`shots.missing`) gets one drawing run (`drawRun`: this file's CLI, its own process and headless browser at the
 *  lowest CPU priority, ended after `deadlineMs`; what it drew by then is kept). One run at a time for all worlds, never
 *  in a world's process or on its clock; none while `canStart()` says no (the host's memory). A run that tried every
 *  place (or drew none) is not repeated for the same missing places until they change or `retryMs` passes; one ended
 *  early (its deadline) that drew some goes on with the rest.
 *  `worlds()`: [{slug, places}] of the moved worlds and their published places (cutover.mjs snapshotPlaces);
 *  `page(slug)`: the world's page URL. → {check(), status(), close()}; `status()` is the gauge (/__sim/metrics). */
export function placeShotKeeper({ shots, dir, worlds, page, run = drawRun, log = () => {}, canStart = () => true, firstMs = 60_000, everyMs = 10 * 60_000, deadlineMs = 45 * 60_000, retryMs = 6 * 3600_000, now = Date.now }) {
  let running = null, closed = false, last = null;
  const signature = (targets) => createHash('sha256').update(JSON.stringify(targets.map((t) => [t.ref, targetKey(t)]))).digest('hex');
  const tried = new Map(), missing = new Map();   // slug → {sig, at} of a run that left the same places missing; slug → count
  const check = () => {
    if (closed || running) return running?.done ?? null;
    let list = [];
    try { list = worlds() ?? []; } catch (e) { log(`place-shots: the moved worlds could not be listed: ${e.message}`); }
    for (const { slug, places } of list) {
      const want = shots.missing(slug, (places ?? []).map((p) => p.target), true);
      missing.set(slug, want.length);
      if (!want.length) { tried.delete(slug); continue; }
      const sig = signature(want), t = tried.get(slug);
      if (t?.sig === sig && now() - t.at < retryMs) continue;
      if (!canStart()) return null;
      const started = now();
      log(`place-shots: drawing ${want.length} of ${places.length} places of ${slug} ahead of visitors`);
      const stop = new AbortController();
      running = { slug, started, count: want.length, stop: () => stop.abort() };
      running.done = Promise.resolve().then(() => run({ slug, page: page(slug), out: join(dir, slug), deadlineMs, signal: stop.signal })).catch((e) => ({ code: null, error: e.message })).then((r) => {
        const still = shots.missing(slug, (places ?? []).map((p) => p.target), true), left = still.length;
        last = { slug, at: new Date(started).toISOString(), ms: now() - started, drawn: Math.max(0, want.length - left), left, code: r?.code ?? null, ...(r?.signal ? { signal: r.signal } : {}), ...(r?.error ? { error: r.error } : {}) };
        missing.set(slug, left);
        // a run that tried every place, or drew none, is not repeated for the same ones; one ended early that drew some goes on
        if (left && (r?.code === 0 || !last.drawn)) tried.set(slug, { sig: signature(still), at: now() });
        log(`place-shots: ${slug}: drew ${last.drawn} in ${Math.round(last.ms / 1000)} s${left ? `, ${left} still missing (the page draws those meanwhile; log ${join(dir, slug, 'draw.log')})` : ''}`);
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
    status: () => ({ running: running ? { slug: running.slug, places: running.count, forS: Math.round((now() - running.started) / 1000) } : null, last, missing: Object.fromEntries(missing) }),
    close() { closed = true; clearTimeout(first); clearInterval(timer); running?.stop?.(); },
  };
}

/** One drawing run of a world: this file's CLI in its own process at the lowest CPU priority (its browser inherits it), its
 *  output in `<out>/draw.log`; SIGTERM at the deadline or on `signal` (Playwright closes its browser), SIGKILL 10 s later. */
export function drawRun({ page, out, deadlineMs, signal }) {
  mkdirSync(out, { recursive: true });
  const fd = openSync(join(out, 'draw.log'), 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--page', page, '--out', out, '--nice', '19'], { stdio: ['ignore', fd, fd] });
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

/** Draws and keeps the pictures `out` has no current one of. `page`: the world's page URL (ending in `/`). */
export async function makeShots({ page, out, chromium, args = [], plan = false, log = () => {} }) {
  const snapshot = await fetch(new URL('v1/world/snapshot', page)).then((r) => (r.ok ? r.json() : Promise.reject(Error(`snapshot ${r.status}`))));
  // the places a plain Explore lists first (its first screen), then the ones only a search finds
  const places = snapshotPlaces(snapshot).sort((a, b) => b.shown - a.shown).map((p) => p.target);
  let kept = {};
  try { kept = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).shots ?? {}; } catch { /* first run */ }
  const missing = places.filter((t) => kept[t.ref]?.target !== targetKey(t) || !existsSync(join(out, `${kept[t.ref]?.sha}.webp`)));
  const shots = Object.fromEntries(places.filter((t) => !missing.includes(t)).map((t) => [t.ref, kept[t.ref]]));
  // written whole (.tmp, then renamed) every 25 pictures and at the end: a stopped run keeps what it drew
  const save = () => { writeFileSync(join(out, 'index.json.tmp'), JSON.stringify({ schema: 'place-shots/1', shots })); renameSync(join(out, 'index.json.tmp'), join(out, 'index.json')); };
  log(`${places.length} places, ${missing.length} to draw`);
  if (plan) return { places: places.length, toDraw: missing.length, kept: Object.keys(shots).length };
  mkdirSync(out, { recursive: true });
  if (missing.length) {
    const browser = await chromium.launch({ headless: true, args });
    try {
      const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const url = new URL(page); url.searchParams.set('placeShots', '1');
      // generous: a background run on a busy host, or a CPU-drawn (SwiftShader) page, takes minutes to arrive
      await tab.goto(url.href, { waitUntil: 'load', timeout: 300_000 });
      await tab.waitForFunction(() => window.__placeShots?.ready(), null, { timeout: 600_000, polling: 1000 })
        .catch(() => { throw Error(`${url.href}: the page never offered window.__placeShots (a build from before #4792, or the world did not load)`); });
      for (const t of missing) {
        // the page's 320 × 224 shot, kept at Explore's card size (256 wide) and WebP quality 0.72: a few KB
        const shot = await tab.evaluate(async (target) => {
          const url = await window.__placeShots.draw(target);
          if (!url) return null;
          const img = new Image(); img.src = url; await img.decode();
          const c = document.createElement('canvas'); c.width = 256; c.height = Math.round(256 * img.height / img.width);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL('image/webp', 0.72);
        }, t).catch(() => null);
        const bytes = typeof shot === 'string' && shot.startsWith('data:image/webp;base64,') ? Buffer.from(shot.slice(23), 'base64') : null;
        if (!bytes) { log(`  ${t.ref} (${t.title}): not drawn`); continue; }
        const sha = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(join(out, `${sha}.webp`), bytes);
        shots[t.ref] = { target: targetKey(t), sha, bytes: bytes.length };
        log(`  ${t.ref} (${t.title}): ${bytes.length} B`);
        if (Object.keys(shots).length % 25 === 0) save();
      }
    } finally { await browser.close(); }
  }
  save();
  return { places: places.length, drawn: missing.filter((t) => shots[t.ref]).length, kept: Object.keys(shots).length };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const page = opt('page'), out = opt('out'), plan = argv.includes('--plan'), nice = Number(opt('nice'));
  if (!page || !out) { console.error('usage: place-shots.mjs --page <world page URL> --out <data>/place-shots/<slug> [--plan] [--nice <0-19>]'); process.exit(2); }
  if (Number.isInteger(nice) && nice >= 0 && nice <= 19) try { setPriority(nice); } catch { /* not allowed here */ }
  const { resolvePlaywright, launchArgs, browsersPath } = await import(pathToFileURL(resolve(import.meta.dirname, '../playtest/lib/platform.mjs')).href);
  browsersPath();
  const pw = resolvePlaywright({ serverRoot: resolve(import.meta.dirname, '../..') });
  if (!pw) { console.error('place-shots: Playwright not found (pnpm install --frozen-lockfile)'); process.exit(1); }
  const r = await makeShots({ page: page.endsWith('/') ? page : `${page}/`, out: resolve(out), chromium: pw.chromium, args: launchArgs().args, plan, log: (s) => console.error(s) });
  console.log(JSON.stringify(r));
}

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
// - made: `node tools/world-launcher/place-shots.mjs --page <world page URL> --out <data>/place-shots/<slug>` opens the
//   world's own page headless (`?placeShots=1`, LiveWorld.tsx), has it draw every place of the published snapshot it has
//   no current picture of, and writes them. Run once a world is moved, and again when its places change; nothing else
//   changes and a run with nothing missing draws nothing.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { snapshotPlaces } from './cutover.mjs';

const SHOT = /^\/v1\/world\/context\/shot\/([0-9a-f]{64})\.webp$/;
const SHA = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** What a place's picture depends on, as the launcher lists it (cutover.mjs snapshotPlaces): where and how it is framed. */
export function targetKey(t) {
  return createHash('sha256').update(JSON.stringify([t.point, t.radius, t.viewpoint ?? null, !!t.enclosed])).digest('hex').slice(0, 32);
}

/** `dir`: `<data>/place-shots`. → {views(slug, refs, places), serve(req, res, slug, rest)}. The index is read again when
 *  its file changes (looked at once a second), so a generator run takes effect without a restart. */
export function placeShots({ dir }) {
  const cache = new Map();
  const index = (slug) => {
    if (!SLUG.test(slug)) return null;
    const file = join(dir, slug, 'index.json'), now = Date.now(), c = cache.get(slug);
    if (c && now - c.at < 1000) return c.shots;
    let mtime = 0; try { mtime = statSync(file).mtimeMs; } catch { /* none */ }
    if (c && c.mtime === mtime) { c.at = now; return c.shots; }
    let shots = null;
    try { const j = JSON.parse(readFileSync(file, 'utf8')); if (j?.schema === 'place-shots/1' && j.shots && typeof j.shots === 'object') shots = j.shots; } catch { /* none */ }
    cache.set(slug, { at: now, mtime, shots });
    return shots;
  };
  return {
    /** POST /v1/world/context/views's answer: a kept picture of the place as it is now, else `draw: 'page'`. */
    views(slug, refs, places) {
      const shots = index(slug), byRef = new Map((places ?? []).map((p) => [p.target.ref, p.target]));
      return refs.map((ref) => {
        const s = shots?.[ref], t = byRef.get(ref);
        return s && t && SHA.test(s.sha ?? '') && s.target === targetKey(t) ? { ref, status: 'ready', thumb: `/v1/world/context/shot/${s.sha}.webp` } : { ref, status: 'unavailable', draw: 'page' };
      });
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

/** Draws and keeps the pictures `out` has no current one of. `page`: the world's page URL (ending in `/`). */
export async function makeShots({ page, out, chromium, args = [], log = () => {} }) {
  const snapshot = await fetch(new URL('v1/world/snapshot', page)).then((r) => (r.ok ? r.json() : Promise.reject(Error(`snapshot ${r.status}`))));
  const places = snapshotPlaces(snapshot).map((p) => p.target);
  mkdirSync(out, { recursive: true });
  let kept = {};
  try { kept = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).shots ?? {}; } catch { /* first run */ }
  const missing = places.filter((t) => kept[t.ref]?.target !== targetKey(t) || !existsSync(join(out, `${kept[t.ref]?.sha}.webp`)));
  const shots = Object.fromEntries(places.filter((t) => !missing.includes(t)).map((t) => [t.ref, kept[t.ref]]));
  // written whole (.tmp, then renamed) every 25 pictures and at the end: a stopped run keeps what it drew
  const save = () => { writeFileSync(join(out, 'index.json.tmp'), JSON.stringify({ schema: 'place-shots/1', shots })); renameSync(join(out, 'index.json.tmp'), join(out, 'index.json')); };
  log(`${places.length} places, ${missing.length} to draw`);
  if (missing.length) {
    const browser = await chromium.launch({ headless: true, args });
    try {
      const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const url = new URL(page); url.searchParams.set('placeShots', '1');
      await tab.goto(url.href, { waitUntil: 'load', timeout: 120_000 });
      await tab.waitForFunction(() => window.__placeShots?.ready(), null, { timeout: 180_000, polling: 500 });
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
  const page = opt('page'), out = opt('out');
  if (!page || !out) { console.error('usage: place-shots.mjs --page <world page URL> --out <data>/place-shots/<slug>'); process.exit(2); }
  const { resolvePlaywright, launchArgs } = await import(pathToFileURL(resolve(import.meta.dirname, '../playtest/lib/platform.mjs')).href);
  const pw = resolvePlaywright({ serverRoot: resolve(import.meta.dirname, '../..') });
  if (!pw) { console.error('place-shots: Playwright not found (pnpm install --frozen-lockfile)'); process.exit(1); }
  const r = await makeShots({ page: page.endsWith('/') ? page : `${page}/`, out: resolve(out), chromium: pw.chromium, args: launchArgs().args, log: (s) => console.error(s) });
  console.log(JSON.stringify(r));
}

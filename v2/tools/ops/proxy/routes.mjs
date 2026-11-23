#!/usr/bin/env node
// The front door's map (Engine v2 O19, #2830): one empty file per explicitly canonical trusted world mapping, in
// <out>/slugs/, which soul-game.caddy's file matcher reads on each request (no proxy reload), and <out>/sitemap.xml:
// today's sitemap plus each listed nonarchived world's page on the public name; archived entries are removed.
//   node v2/tools/ops/proxy/routes.mjs --directory http://localhost:7310 --launcher http://localhost:<port> \
//     --origin https://soul.game --out /var/lib/souls-routes
// When the directory or the launcher does not answer, nothing is changed (the last map keeps routing) and it exits 1.
// New slugs are added before stale ones are removed. Prints one line: `routes: <n> slugs (+a -r), sitemap <m> urls`.
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorldRoutes, WORLD_ROUTES } from '../../origin/world-routes.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The slugs the directory lists (W3's `GET /v1/worlds`). */
export function listedSlugs(list) {
  return [...new Set((list?.worlds ?? []).map((w) => w?.name).filter((n) => typeof n === 'string' && SLUG.test(n)))].sort();
}

/** Today's sitemap with each listed slug's page added (once). */
export function mergedSitemap(todayXml, origin, slugs, archived = []) {
  const hidden = new Set(archived);
  const locs = [...todayXml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => unxml(m[1])).filter(at => {
    try { const url = new URL(at), match = /^\/w\/([^/]+)(?:\/|$)/.exec(url.pathname); return url.origin !== new URL(origin).origin || !match || !hidden.has(match[1]); }
    catch { return true; }
  });
  const all = [...new Set([...locs, ...slugs.map((s) => `${origin}/w/${s}/`)])];
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...all.map((u) => `  <url><loc>${xml(u)}</loc></url>`), '</urlset>', ''].join('\n');
}

export async function makeRoutes({ directory, launcher, origin, out, worldRoutes = process.env.SOULS_WORLD_ROUTES || WORLD_ROUTES, fetchImpl = fetch }) {
  const get = async (url, kind) => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'souls-routes' } });
    if (!r.ok) throw Error(`${url}: ${r.status}`);
    return kind === 'json' ? r.json() : r.text();
  };
  const mapped = readWorldRoutes(worldRoutes);
  const listed = listedSlugs(await get(`${directory}/v1/worlds`, 'json')).filter(slug => mapped[slug]?.canonical && !mapped[slug]?.archived);
  const slugs = Object.keys(mapped).filter(slug => mapped[slug].canonical).sort();
  const sitemap = mergedSitemap(await get(`${launcher}/sitemap.xml`, 'text'), origin, listed, Object.keys(mapped).filter(slug => mapped[slug].archived));
  const dir = join(out, 'slugs');
  mkdirSync(dir, { recursive: true });
  const had = new Set(readdirSync(dir)), want = new Set(slugs);
  let added = 0, removed = 0;
  for (const s of slugs) if (!had.has(s)) { writeFileSync(join(dir, s), ''); added++; }
  for (const s of had) if (!want.has(s)) { rmSync(join(dir, s), { force: true }); removed++; }
  writeFileSync(join(out, 'sitemap.xml.tmp'), sitemap);
  renameSync(join(out, 'sitemap.xml.tmp'), join(out, 'sitemap.xml'));
  return { slugs, added, removed, urls: (sitemap.match(/<loc>/g) ?? []).length };
}

if (isMain(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  try {
    const r = await makeRoutes({ directory: opt('--directory', 'http://localhost:7310'), launcher: opt('--launcher'), origin: opt('--origin', 'https://soul.game'), out: opt('--out', '/var/lib/souls-routes') });
    console.log(`routes: ${r.slugs.length} slugs (+${r.added} -${r.removed}), sitemap ${r.urls} urls`);
  } catch (e) {
    console.error(`routes: unchanged: ${e.message}`);
    process.exitCode = 1;
  }
}

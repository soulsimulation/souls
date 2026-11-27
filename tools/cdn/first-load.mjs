#!/usr/bin/env node
// What one new viewer's cold page load costs the host (#4986): the gauge of the "new visitors" row in
// docs/architecture/scaling.md, origin bytes against edge bytes. Loads ONE page once in Playwright Chromium with an
// empty profile, records every request (host, path class, bytes on the wire, cache headers) and says for each whether
// the host answered it or an edge did. Read-only and signed out; one viewer, never a load test.
//   node tools/cdn/first-load.mjs <outDir> <url> [--wait 25000] [--origin-hosts soul.game] [--label before]
// "From the host" is: a response on an origin host (--origin-hosts, default the page's own host) that carries no
// cf-cache-status of HIT/REVALIDATED/STALE/UPDATING, or a response on any other host that Cloudflare had to fetch
// (MISS/EXPIRED/DYNAMIC/BYPASS). A MISS is the host's cost once per edge and object, not once per viewer; the summary
// keeps the two apart (`host` and `edgeFill`).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE_SERVED = new Set(['HIT', 'REVALIDATED', 'STALE', 'UPDATING']);

/** The class of a path on a Souls host: what kind of first-load file it is. */
export function pathClass(pathname) {
  const p = pathname.replace(/^\/worlds(?=\/)/, '');
  if (/^\/s\//.test(p)) return 'stream';
  if (/^\/w\/[^/]+\/v2\/replica\//.test(p)) return 'replica';
  if (/^\/w\/[^/]+\/v2\/bodies\//.test(p)) return 'bodies';
  if (/^\/w\/[^/]+\/(?:v1|v2)\//.test(p) || /^\/__sim\//.test(p) || /^\/v1\//.test(p)) return 'api';
  if (/^\/w\/[^/]+\/?$/.test(p) || p === '/') return 'page';
  if (/^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css|mjs)$/.test(p)) return 'bundles';
  if (/\.(?:glb|bin|ktx2|png|jpe?g|webp|avif|hdr|exr|svg|ico)$/i.test(p)) return 'models-and-images';
  if (/\.(?:wasm|woff2?|ttf|otf)$/i.test(p)) return 'wasm-and-fonts';
  if (/\.(?:json|webmanifest)$/i.test(p)) return 'data';
  return 'other';
}

/** Who paid for a response: 'host' (the origin answered this viewer), 'edgeFill' (an edge asked the origin, then keeps
 *  it), 'edge' (an edge answered alone) or 'third' (a host that is not ours: sign-in, analytics). */
export function servedBy({ host, cf, originHosts, ourHosts }) {
  const status = (cf ?? '').toUpperCase();
  if (!ourHosts.some((h) => host === h || host.endsWith('.' + h))) return 'third';
  if (EDGE_SERVED.has(status)) return 'edge';
  if (originHosts.includes(host)) return status === 'MISS' || status === 'EXPIRED' ? 'edgeFill' : 'host';
  return status === 'MISS' || status === 'EXPIRED' ? 'edgeFill' : status ? 'host' : 'edge';
}

/** Rows → {byHost, byClass (origin hosts only), totals}. Bytes are bytes on the wire (headers + encoded body). */
export function summarize(rows, { originHosts }) {
  const add = (m, k, r) => { const e = (m[k] ??= { requests: 0, bytes: 0, host: 0, hostBytes: 0, edge: 0, edgeBytes: 0, edgeFill: 0, edgeFillBytes: 0 }); e.requests++; e.bytes += r.bytes; if (r.servedBy !== 'third') { e[r.servedBy]++; e[r.servedBy + 'Bytes'] += r.bytes; } };
  const byHost = {}, byClass = {}, totals = {};
  for (const r of rows) {
    add(byHost, r.host, r); add(totals, r.servedBy, r);
    if (originHosts.includes(r.host)) add(byClass, r.class, r);
  }
  return { byHost, byClass, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { requests: v.requests, bytes: v.bytes }])) };
}

function findChromium() {
  const bases = [process.env.EDEN_GOD_PLAYWRIGHT_FROM, process.cwd(), resolve(HERE, '../../mars/viewer'), resolve(HERE, '../..')].filter(Boolean);
  for (const b of bases) for (const name of ['playwright-core', 'playwright', '@playwright/test']) {
    try { const m = createRequire(resolve(b, 'package.json'))(name); if (m?.chromium) return m.chromium; } catch { /* next */ }
  }
  throw Error('Playwright not found: run from a checkout with mars/viewer installed, or set EDEN_GOD_PLAYWRIGHT_FROM');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const WAIT = Number(opt('wait', 25000)), label = opt('label', 'load');
  const [out, url] = args;
  if (!out || !url) throw Error('usage: first-load.mjs <outDir> <url> [--wait ms] [--origin-hosts a,b] [--label name]');
  const site = new URL(url).host, apex = site.split('.').slice(-2).join('.');
  const originHosts = opt('origin-hosts', site).split(',');
  const ourHosts = site === apex ? [apex] : [apex, site];
  mkdirSync(out, { recursive: true });
  const linux = process.platform === 'linux';
  const launch = { headless: true, args: linux ? ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist'] };
  const chromium = findChromium();   // the full Chromium when it is installed, else Playwright's headless shell
  const browser = await chromium.launch({ channel: 'chromium', ...launch }).catch(() => chromium.launch(launch));
  const rows = [], failed = [], errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });   // a new context is an empty profile: no cache, no cookies
    const page = await ctx.newPage(), t0 = Date.now(), pending = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('requestfailed', (r) => failed.push({ url: r.url().split('?')[0], error: r.failure()?.errorText ?? null }));
    page.on('requestfinished', (req) => pending.push((async () => {
      const res = await req.response(); if (!res) return;
      const u = new URL(req.url()); if (!/^https?:$/.test(u.protocol)) return;
      const h = res.headers(), s = await req.sizes().catch(() => null);
      const cf = h['cf-cache-status'] ?? null;
      rows.push({
        t: Date.now() - t0, host: u.host, path: u.pathname + (u.search ? '?…' : ''), class: pathClass(u.pathname), method: req.method(), type: req.resourceType(), status: res.status(),
        bytes: s ? s.responseHeadersSize + s.responseBodySize : 0, bodyBytes: s?.responseBodySize ?? 0,
        encoding: h['content-encoding'] ?? null, cacheControl: h['cache-control'] ?? null, cf, age: h.age ?? null, server: h.server ?? null,
        servedBy: servedBy({ host: u.host, cf, originHosts, ourHosts }),
      });
    })()));
    const navigationStatus = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).then((r) => r?.status() ?? null).catch((e) => { errors.push('goto ' + e.message.slice(0, 120)); return null; });
    await page.waitForTimeout(WAIT);
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 5000))]);
    await page.screenshot({ path: `${out}/${label}.png` }).catch(() => {});
    rows.sort((a, b) => a.t - b.t);
    const summary = { url, label, at: new Date().toISOString(), waitMs: WAIT, navigationStatus, originHosts, requests: rows.length, failed: failed.length, errors, ...summarize(rows, { originHosts }) };
    writeFileSync(`${out}/${label}.json`, JSON.stringify({ summary, rows, failed }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
  } finally { await browser.close(); }
}

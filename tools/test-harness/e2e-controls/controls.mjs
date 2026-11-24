#!/usr/bin/env node
// The controls gate: every main control in a world page's header, clicked in real headless Chromium, on every moved world.
// A release once shipped with Sign in and "Back 1 min" broken on /w/eden/ and no gate noticed; this is the gate that would
// have. It only clicks: it never submits a form, never signs in and never changes a world, so it is safe against production.
//
//   node tools/test-harness/e2e-controls/controls.mjs [--origin https://soul.game] [--slugs eden,rna-studio]
//        [--out .local/e2e-controls/<time>] [--concurrency 2]
//
// Without --slugs it walks every listed world whose page config carries `v2Stream` (moved to the new engine).
// A world fails on any failed step, any console error on the page's own origin, or any 4xx/5xx answered by the page's own
// origin (ALLOW below is the only exception). Per world: <out>/<slug>/verdict.json and one screenshot per step;
// <out>/summary.json for the run. Exit 0 = every world and site probe passed, 1 = something failed, 2 = usage.
// Playwright comes from mars/viewer (ship/browser.mjs; SHIP_PLAYWRIGHT_FROM overrides). SHIP_GPU=<label> uses the release
// eyes' hardware GL launch; unset, Playwright's own Chromium, headless.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../lib/is-main.mjs';
import { chromium, launchOptions } from '../../world-launcher/deploy/ship/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Same-origin requests that answer 4xx/5xx BY DESIGN. Each entry needs a reason; keep it empty if at all possible.
 *  { method: 'GET', path: /^\/example$/, status: 404, why: '…' } */
export const ALLOW = [];

/** Should this same-origin error response fail the world? */
export function badResponse({ method, path, status }, allow = ALLOW) {
  if (status < 400) return false;
  return !allow.some((a) => (!a.method || a.method === method) && a.path.test(path) && (!a.status || a.status === status));
}

/** The site-level probes Sign in depends on: [{name, method, path, want}]. */
export const siteProbes = (slugs) => [
  { name: 'view-token without a token', method: 'POST', path: '/v1/account/view-token', want: 401 },
  { name: 'static asset manifest', method: 'GET', path: '/mars-assets/static-manifest.json', want: 200 },
  ...slugs.map((s) => ({ name: `${s} /v1/me unauthenticated`, method: 'GET', path: `/w/${s}/v1/me`, want: 401 })),
];

/** Errors as printed: numbered paths collapsed (`/bundles/N/index` once, with a count), and a console "Failed to load
 *  resource" dropped where its response is already listed. verdict.json keeps every error as seen. */
export function brief(errors) {
  const counts = new Map();
  for (const e of errors) {
    if (/^console: Failed to load resource/.test(e)) continue;
    const k = e.replace(/\/\d+(?=\/|\s|$)/g, '/N'); counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} (x${n})` : k));
}

/** A world's verdict from its steps and the errors seen on its own origin. */
export function verdict(slug, steps) {
  const failures = steps.filter((s) => !s.ok).map((s) => `${s.name}: ${[s.detail, ...brief(s.errors)].filter(Boolean).join(' | ')}`);
  return { slug, ok: failures.length === 0, failures, steps };
}

const arg = (argv, k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function movedSlugs(origin) {
  const list = await fetch(`${origin}/__sim/worlds.json`).then((r) => r.json());
  const out = [];
  for (const w of list.worlds ?? []) {
    if (w.unlisted || !w.slug) continue;
    const html = await fetch(`${origin}/w/${w.slug}/`).then((r) => r.text()).catch(() => '');
    if (/"v2Stream":"\/s\//.test(html)) out.push(w.slug);
  }
  return out;
}

async function probeSite(origin, slugs) {
  const res = [];
  for (const p of siteProbes(slugs)) {
    const status = await fetch(origin + p.path, { method: p.method, headers: p.method === 'POST' ? { 'content-type': 'application/json' } : {}, body: p.method === 'POST' ? '{}' : undefined })
      .then((r) => r.status).catch(() => 0);
    res.push({ ...p, status, ok: status === p.want });
  }
  return res;
}

async function walkWorld(browser, origin, slug, dir) {
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const host = new URL(origin).host;
  let errs = [];
  const watch = (page) => {
    page.on('console', (m) => { if (m.type() === 'error' && new URL(page.url()).host === host) errs.push(`console: ${m.text().slice(0, 200)}${m.location()?.url ? ` (${m.location().url.replace(origin, '').slice(0, 120)})` : ''}`); });
    page.on('pageerror', (e) => { if (new URL(page.url()).host === host) errs.push(`pageerror: ${String(e?.message ?? e).slice(0, 200)}`); });
    page.on('response', (r) => {
      let u; try { u = new URL(r.url()); } catch { return; }
      if (u.host !== host) return;
      const x = { method: r.request().method(), path: u.pathname, status: r.status() };
      if (badResponse(x)) errs.push(`${x.status} ${x.method} ${x.path}`);
    });
  };
  ctx.on('page', watch);
  const page = await ctx.newPage();
  const steps = [];
  const view = (p = page) => p.evaluate(() => { const d = document.querySelector('.viewer-history')?.dataset ?? {}; return { pres: d.viewerPresentation ?? null, tick: d.viewerTick ? Number(d.viewerTick) : null, camera: document.querySelector('[data-camera]')?.dataset.camera ?? null }; }).catch(() => ({}));
  const notLoaded = (p = page) => p.evaluate(() => [...document.querySelectorAll('.warn, [role=status], .explore-note')].map((e) => e.textContent?.trim() ?? '').find((t) => /could not be loaded|temporarily unavailable/i.test(t)) ?? null).catch(() => null);
  const until = async (fn, ms, every = 250) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(every); } return null; };
  const step = async (name, fn) => {
    errs = []; const t0 = Date.now(); let detail = null, ok = true;
    try { detail = (await fn()) ?? null; } catch (e) { ok = false; detail = String(e?.message ?? e).split('\n')[0].slice(0, 240); }
    await sleep(300);
    const shot = `${String(steps.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    await page.screenshot({ path: join(dir, shot) }).catch(() => {});
    const s = { name, ok: ok && errs.length === 0, ms: Date.now() - t0, detail, errors: [...new Set(errs)], shot };
    steps.push(s); const shown = brief(s.errors);
    console.log(`[${slug}] ${s.ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}${shown.length ? ` [${shown.join(' | ')}]` : ''}`);
    return s;
  };
  const fail = (m) => { throw Error(m); };
  // Controls are pressed with `force`: the bar re-renders every tick, so Playwright's "stable" wait can time out on a
  // working button. A press waits for the button to be shown and enabled (a busy page disables "Back 1 min" while it
  // loads) and is tried up to 3 times. Only the click is retried: each step then waits for its result (a menu, a
  // moment, a form), so a dead button still fails, and every 4xx/5xx and console error still counts.
  const press = async (loc, tries = 3) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        await loc.waitFor({ state: 'visible', timeout: 15000 });
        await until(() => loc.isEnabled().catch(() => false), 15000);
        await loc.click({ force: true, timeout: 10000 });
        return;
      } catch (e) { last = e; await sleep(1000); }
    }
    throw last;
  };
  const escape = async () => { await page.keyboard.press('Escape'); await sleep(300); };
  const back = async (label) => {
    const before = await view();
    if (before.tick == null) fail('no moment shown before the click');
    await press(page.getByRole('button', { name: 'Back 1 min', exact: true }));
    const landed = await until(async () => { const v = await view(); const bad = await notLoaded(); if (bad) return { bad }; return v.pres === 'history' && v.tick < before.tick ? v : null; }, 25000);
    if (!landed) fail(`${label}: never landed on an earlier moment (presentation ${(await view()).pres})`);
    if (landed.bad) fail(`${label}: "${landed.bad}"`);
    return `tick ${before.tick} -> ${landed.tick}`;
  };

  await step('load', async () => {
    await page.goto(`${origin}/w/${slug}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!await until(async () => (await view()).tick != null, 60000)) fail('no moment drawn in 60 s');
    await sleep(3000);
    return `presentation ${(await view()).pres}`;
  });
  await step('Live', async () => {
    await press(page.locator('.live-pill').first());
    await page.locator('input[aria-label="Preview hour"]').waitFor({ state: 'visible', timeout: 5000 });
    await escape();
  });
  await step('Back 1 min', () => back('Back 1 min'));
  await step('Back again', () => back('Back again'));
  await step('From the start', async () => {
    const before = await view();
    await press(page.getByRole('button', { name: 'From the start', exact: true }));
    const landed = await until(async () => { const bad = await notLoaded(); if (bad) return { bad }; const v = await view(); return v.pres === 'history' && v.tick < (before.tick ?? Infinity) ? v : null; }, 25000);
    if (!landed) fail('never landed on the first moment');
    if (landed.bad) fail(`"${landed.bad}"`);
    return `tick ${landed.tick}`;
  });
  await step('Link to this moment', async () => {
    const b = page.getByRole('button', { name: 'Link to this moment', exact: true });
    await press(b);
    const link = await until(() => page.evaluate(() => document.querySelector('[data-moment-link]')?.getAttribute('data-moment-link') || null), 5000);
    if (!link) fail('no link was made');
    const tab = await ctx.newPage();
    try {
      await tab.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const v = await until(async () => { const bad = await notLoaded(tab); if (bad) return { bad }; const x = await view(tab); return x.tick != null && x.pres === 'history' ? x : null; }, 45000);
      if (!v) fail(`the link's tab never showed the moment (presentation ${(await view(tab)).pres})`);
      if (v.bad) fail(`the link's tab: "${v.bad}"`);
      await tab.screenshot({ path: join(dir, 'moment-link-tab.png') }).catch(() => {});
      return `new tab at tick ${v.tick}`;
    } finally { await tab.close().catch(() => {}); }
  });
  await step('Return to live', async () => {
    const r = page.getByRole('button', { name: 'Return to live', exact: true });
    if (await r.count()) await press(r);
    if (!await until(async () => (await view()).pres === 'live', 20000)) fail('never back to live');
  });
  await step('Broadcast menu', async () => {
    await press(page.locator('button[aria-label="Camera modes and help"]').first());
    await page.locator('[role=dialog][aria-label="Camera modes and help"]').waitFor({ state: 'visible', timeout: 5000 });
    await escape();
  });
  await step('Sound toggle', async () => {
    await press(page.locator('button[aria-label="Audio"]').first());
    const sw = page.locator('[role=dialog][aria-label="Audio"] [role=switch]').first();
    await sw.waitFor({ state: 'visible', timeout: 5000 });
    const a = (await sw.textContent())?.trim();
    await sw.click(); await sleep(300);
    const b = (await sw.textContent())?.trim();
    await sw.click(); await sleep(300);
    await escape();
    if (a === b) fail(`the switch did not change ("${a}")`);
    return `${a} -> ${b} -> back`;
  });
  await step('Search (Explore)', async () => {
    await press(page.locator('.explore-open').first());
    await page.locator('input.explore-search').waitFor({ state: 'visible', timeout: 5000 });
    return `${await page.locator('.explore-soul').count()} Souls listed`;
  });
  await step('Places', async () => {
    const bad = await until(() => notLoaded(), 3000);
    if (bad) fail(`"${bad}"`);
    const places = page.locator('.explore-locations button');
    const n = await places.count();
    if (!n) return 'no places listed';
    await press(places.first());
    return `${n} places; clicked the first`;
  });
  await step('Follow a Soul', async () => {
    if (!await page.locator('input.explore-search').isVisible()) await press(page.locator('.explore-open').first());
    const soul = page.locator('.explore-soul').first();
    await soul.waitFor({ state: 'visible', timeout: 10000 });
    const name = (await soul.textContent())?.trim();
    await press(soul);
    if (!await until(async () => (await view()).camera === 'follow', 20000)) fail(`clicking ${name} did not follow (camera ${(await view()).camera})`);
    return `following ${name}`;
  });
  await escape();
  await step('New Soul', async () => {
    await press(page.locator('.bring-agent-open').first());
    await page.locator('section.bring-agent').waitFor({ state: 'visible', timeout: 5000 });
    await escape();
  });
  await step('Sign in', async () => {
    const form = () => until(async () => {
      for (const f of page.frames()) {
        const n = await f.locator('input[type=email]:visible, input[name=identifier]:visible, input[name=emailAddress]:visible, input[autocomplete=username]:visible').count().catch(() => 0);
        if (n) return true;
      }
      return false;
    }, 15000, 500);
    await press(page.locator('.account-sign-in').first());
    if (await form()) { const u = new URL(page.url()); return `sign-in form at ${u.host}${u.pathname}`; }
    // the click may open the account panel first, with its own Sign in
    const again = page.locator('[role=dialog] button:has-text("Sign in"), dialog button:has-text("Sign in")').first();
    if (await again.count()) { await again.click({ timeout: 10000 }).catch(() => {}); if (await form()) { const u = new URL(page.url()); return `sign-in form at ${u.host}${u.pathname} (via the account panel)`; } }
    const u = new URL(page.url());
    fail(`no sign-in form; the page is ${u.host}${u.pathname}`);
  });
  await ctx.close().catch(() => {});
  const v = verdict(slug, steps);
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ ...v, origin, at: new Date().toISOString() }, null, 1) + '\n');
  return v;
}

export async function main(argv = process.argv.slice(2)) {
  const origin = arg(argv, 'origin', 'https://soul.game').replace(/\/$/, '');
  const out = resolve(arg(argv, 'out', join(ROOT, '.local/e2e-controls', new Date().toISOString().replace(/[:.]/g, '-'))));
  const concurrency = Math.max(1, Number(arg(argv, 'concurrency', 2)));
  const slugs = arg(argv, 'slugs', null)?.split(',').filter(Boolean) ?? await movedSlugs(origin);
  if (!slugs.length) { console.error('controls: no moved worlds found (--slugs a,b)'); return 2; }
  mkdirSync(out, { recursive: true });
  console.log(`controls: ${origin}, ${slugs.length} world(s): ${slugs.join(' ')}; out ${out}`);
  const site = await probeSite(origin, slugs);
  for (const p of site) console.log(`[site] ${p.ok ? 'ok  ' : 'FAIL'} ${p.method} ${p.path} -> ${p.status} (want ${p.want})`);
  const browser = await chromium().launch(process.env.SHIP_GPU ? launchOptions([]) : { headless: true });
  const worlds = [], queue = [...slugs];
  await Promise.all(Array.from({ length: Math.min(concurrency, slugs.length) }, async () => {
    for (let s; (s = queue.shift());) {
      try { worlds.push(await walkWorld(browser, origin, s, join(out, s))); }
      catch (e) { worlds.push(verdict(s, [{ name: 'walk', ok: false, detail: String(e?.message ?? e).split('\n')[0], errors: [] }])); }
    }
  }));
  await browser.close().catch(() => {});
  worlds.sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));
  const ok = site.every((p) => p.ok) && worlds.every((w) => w.ok);
  const summary = { origin, at: new Date().toISOString(), ok, site, worlds: worlds.map(({ slug, ok: wok, failures }) => ({ slug, ok: wok, failures })) };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  console.log(`\ncontrols: ${ok ? 'PASS' : 'FAIL'}`);
  for (const p of site) if (!p.ok) console.log(`  site: ${p.method} ${p.path} -> ${p.status}, want ${p.want}`);
  for (const w of worlds) for (const f of w.failures) console.log(`  ${w.slug}: ${f}`);
  console.log(`summary: ${join(out, 'summary.json')}`);
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exit(await main());

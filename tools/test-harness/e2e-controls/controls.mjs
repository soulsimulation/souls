#!/usr/bin/env node
// The controls gate: every main control in a world page's header, clicked in real headless Chromium, on every moved world.
// Time (Gene, 24 Nov): the header's one time control is the pill; every time control is pressed inside the panel it opens.
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

/** A world day's bundle index, as the page's history worker asks for it: `<history base>bundles/<day>/index`. */
export const DAY_INDEX = /^(.*\/history\/)bundles\/(\d{8})\/index$/;
const DAY_US = 86_400_000_000, TICK_US = 50_000;

/** #5144: the page's history walk (apps/web/src/v2-engine/history-keys.ts `walk`, v2/docs/archive.md rule 8) asks for a
 *  day's index and, when the day has none, goes on to the day before, back to the newest day that has one. A world still
 *  for days wrote no index for them, so each is a 404 the walk expects. A 404 for `day` is such a miss when:
 *  - the page found an index below it (`reads`, day -> the last status seen for this world: 200 on the nearest day read
 *    below it, every day between read and 404). A walk that found none ran past the world's first day: it fails;
 *  - the day is not after the world's own today (`nowDay`): no walk asks for one (#5140); and
 *  - the world had no public event that day (`eventful` false): a day with one wrote a bundle, so its index is real and
 *    missing. Its event index (`history/everyone/events/<day>`) is the check's own read of that, a lower bound: a day
 *    whose record was only motion has none, and its missing index passes. */
export function walkBackMiss(day, reads, { nowDay = Infinity, eventful = false } = {}) {
  if (day > nowDay || eventful) return false;
  for (let d = day - 1; d >= 0; d--) {
    const s = reads.get(d);
    if (s === 200) return true;
    if (s !== 404) return false;
  }
  return false;
}

/** The world day of a tick (50 ms) of world time. */
export const dayOfTick = (tick) => Math.floor((tick * TICK_US) / DAY_US);

/** A step's held day-index errors (`held`: [{path, line}], a 404 and its console line), settled at the step's end against
 *  the world's reads: the lines that still count. `eventful(base, day)` reads whether the day had a public event. */
export async function settleMisses(held, reads, { nowDay = Infinity, eventful }) {
  const out = [];
  for (const h of held) {
    const m = DAY_INDEX.exec(h.path);
    const day = Number(m[2]), r = reads.get(m[1]) ?? new Map();
    if (!walkBackMiss(day, r, { nowDay })) { out.push(h.line); continue; }
    if (await eventful(m[1], day)) out.push(`${h.line} (a day with public events: its index is missing)`);
  }
  return out;
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

/** What a step not run because its world's `load` step failed is marked with. It is not a pass: the world fails. */
export const SKIPPED_AFTER_LOAD = 'skipped-after-load-failure';

/** A world's verdict from its steps and the errors seen on its own origin. Steps skipped after a failed load are named
 *  in one line, after the load's own failure. */
export function verdict(slug, steps) {
  const failures = steps.filter((s) => !s.ok && !s.skipped).map((s) => `${s.name}: ${[s.detail, ...brief(s.errors)].filter(Boolean).join(' | ')}`);
  const skipped = steps.filter((s) => s.skipped);
  if (skipped.length) failures.push(`${skipped.length} step(s) ${SKIPPED_AFTER_LOAD}: ${skipped.map((s) => s.name).join(', ')}`);
  return { slug, ok: failures.length === 0 && skipped.length === 0, failures, steps };
}

/** What Follow a Soul says when the world's Explore lists no Soul. It passes, as Places does with no places: there is no
 *  control to press. A Soul listed that does not follow still fails. */
export const NO_SOUL_TO_FOLLOW = 'no Soul listed in Explore: nothing to follow';

/** Follow a Soul: open Explore (a place clicked closes it), click its first Soul, the camera follows it. A world whose
 *  Explore lists none (it lists only bodies a Soul drives, from the new engine's stream) gets NO_SOUL_TO_FOLLOW instead
 *  of a 10 s wait for a row that never comes. `camera()` reads the page's camera mode. */
export async function followSoul(page, { press, until, camera }) {
  const search = page.locator('input.explore-search');
  if (!await search.isVisible()) await press(page.locator('.explore-open').first());
  const soul = page.locator('.explore-soul').first();
  try { await soul.waitFor({ state: 'visible', timeout: 10000 }); } catch (e) {
    if (await search.isVisible() && !await page.locator('.explore-soul').count()) return NO_SOUL_TO_FOLLOW;
    throw e;
  }
  // Explore searches its locations again each time it opens. When they come, the centred dialog grows and its Soul rows
  // move up, so a click aimed before that lands where the row was (release 0.138 on Eden: Explore stayed open, the camera
  // free). Click once the search is done and the row has held still for 250 ms; a row that never settles is clicked anyway.
  const searching = page.locator('.explore-modal [aria-live=polite]').first();
  await until(async () => {
    if (/searching/i.test(await searching.textContent({ timeout: 1000 }).catch(() => '') ?? '')) return false;
    const a = await soul.boundingBox(); await sleep(250); const b = await soul.boundingBox();
    return !!a && !!b && a.x === b.x && a.y === b.y;
  }, 10000);
  const name = (await soul.locator('b').first().textContent())?.trim();
  await press(soul);
  if (!await until(async () => (await camera()) === 'follow', 20000)) throw Error(`clicking ${name} did not follow (camera ${await camera()})`);
  return `following ${name}`;
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
  let errs = [], held = [];
  // Day indexes read, per history base: day -> the last status. A 404 for one is held to the step's end (walkBackMiss).
  const reads = new Map(), events = new Map();
  const dayPath = (url) => { try { const u = new URL(url); return u.host === host && DAY_INDEX.test(u.pathname) ? u.pathname : null; } catch { return null; } };
  const eventful = (base, day) => {
    const k = `${base}${day}`;
    if (!events.has(k)) events.set(k, fetch(`${origin}${base}history/everyone/events/${String(day).padStart(8, '0')}`).then((r) => r.status === 200).catch(() => false));
    return events.get(k);
  };
  const watch = (page) => {
    page.on('console', (m) => {
      if (m.type() !== 'error' || new URL(page.url()).host !== host) return;
      const line = `console: ${m.text().slice(0, 200)}${m.location()?.url ? ` (${m.location().url.replace(origin, '').slice(0, 120)})` : ''}`;
      const p = /^Failed to load resource/.test(m.text()) && dayPath(m.location()?.url ?? '');
      if (p) held.push({ path: p, line }); else errs.push(line);
    });
    page.on('pageerror', (e) => { if (new URL(page.url()).host === host) errs.push(`pageerror: ${String(e?.message ?? e).slice(0, 200)}`); });
    page.on('response', (r) => {
      let u; try { u = new URL(r.url()); } catch { return; }
      if (u.host !== host) return;
      const x = { method: r.request().method(), path: u.pathname, status: r.status() };
      const d = DAY_INDEX.exec(x.path);
      if (d && (x.status === 200 || x.status === 404)) {
        if (!reads.has(d[1])) reads.set(d[1], new Map());
        reads.get(d[1]).set(Number(d[2]), x.status);
        if (x.status === 404) { held.push({ path: x.path, line: `${x.status} ${x.method} ${x.path}` }); return; }
      }
      if (badResponse(x)) errs.push(`${x.status} ${x.method} ${x.path}`);
    });
  };
  ctx.on('page', watch);
  const page = await ctx.newPage();
  const steps = [];
  // The world's own today: the newest tick drawn, run on by the wall since (world time runs at the wall's pace).
  let seen = null;
  const nowDay = () => (seen ? dayOfTick(seen.tick + (Date.now() - seen.at) / 50) : Infinity);
  const look = (p = page) => p.evaluate(() => { const d = document.querySelector('.viewer-history')?.dataset ?? {}; return { pres: d.viewerPresentation ?? null, tick: d.viewerTick ? Number(d.viewerTick) : null, camera: document.querySelector('[data-camera]')?.dataset.camera ?? null, pill: document.querySelector('.time-pill')?.textContent?.trim() ?? null, clock: document.querySelector('.time-panel-clock')?.textContent?.trim() ?? null }; }).catch(() => ({}));
  const view = async (p = page) => { const v = await look(p); if (v.tick != null && (!seen || v.tick > seen.tick)) seen = { tick: v.tick, at: Date.now() }; return v; };
  const notLoaded = (p = page) => p.evaluate(() => [...document.querySelectorAll('.warn, [role=status], .explore-note')].map((e) => e.textContent?.trim() ?? '').find((t) => /could not be loaded|temporarily unavailable/i.test(t)) ?? null).catch(() => null);
  const until = async (fn, ms, every = 250) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(every); } return null; };
  // A world whose page never loaded has nothing to click: its remaining steps are skipped (and fail the world) instead
  // of each waiting out its own timeouts, so one stuck world costs its load step, not 20 minutes.
  let loadFailed = false;
  const step = async (name, fn) => {
    if (loadFailed) {
      const s = { name, ok: false, skipped: SKIPPED_AFTER_LOAD, ms: 0, detail: SKIPPED_AFTER_LOAD, errors: [] };
      steps.push(s); console.log(`[${slug}] skip ${name}: ${SKIPPED_AFTER_LOAD}`);
      return s;
    }
    errs = []; held = []; const t0 = Date.now(); let detail = null, ok = true;
    try { detail = (await fn()) ?? null; } catch (e) { ok = false; detail = String(e?.message ?? e).split('\n')[0].slice(0, 240); }
    await sleep(300);
    const h = held; held = [];
    errs.push(...await settleMisses(h, reads, { nowDay: nowDay(), eventful }));
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
  // The time panel: the pill opens it; every time control is a button inside it (none is in the header).
  const panel = page.locator('.time-panel');
  const openPanel = async () => {
    if (await panel.isVisible().catch(() => false)) return;
    await press(page.locator('.time-pill').first());
    if (!await until(() => panel.isVisible().catch(() => false), 5000)) fail('the time pill opened no panel');
  };
  const moment = async (name) => { await openPanel(); return panel.getByRole('button', { name, exact: true }); };
  // nothing time-related in the header but the pill
  const headerTime = () => page.evaluate(() => [...document.querySelectorAll('.hud-status button, .hud-status input, .viewer-status button, .viewer-status input')]
    .filter((e) => !e.classList.contains('time-pill')).map((e) => e.getAttribute('aria-label') || e.textContent?.trim() || e.tagName)).catch(() => []);
  const back = async (label) => {
    const before = await view();
    if (before.tick == null) fail('no moment shown before the click');
    const url = page.url();
    await press(await moment('Back 1 min'));
    const landed = await until(async () => { const v = await view(); const bad = await notLoaded(); if (bad) return { bad }; return v.pres === 'history' && v.tick < before.tick && !/Loading/.test(v.pill ?? '') ? v : null; }, 25000);
    if (!landed) fail(`${label}: never landed on an earlier moment (presentation ${(await view()).pres})`);
    if (landed.bad) fail(`${label}: "${landed.bad}"`);
    if (page.url() !== url) fail(`${label}: the page navigated (${url} -> ${page.url()})`);
    // 1 min = 60 s of world time; playback runs on between the two reads, so it lands a little under a minute back
    const back = (before.tick - landed.tick) * 0.05;
    if (back < 50 || back > 70) fail(`${label}: moved ${back.toFixed(1)} s, not about 60`);
    if (!/^Recorded · /.test(landed.pill ?? '')) fail(`${label}: the pill reads "${landed.pill}"`);
    return `tick ${before.tick} -> ${landed.tick} (${back.toFixed(1)} s); clock ${landed.clock}; pill "${landed.pill}"`;
  };

  const load = await step('load', async () => {
    await page.goto(`${origin}/w/${slug}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!await until(async () => (await view()).tick != null, 60000)) fail('no moment drawn in 60 s');
    await sleep(3000);
    return `presentation ${(await view()).pres}`;
  });
  loadFailed = !load.ok;
  await step('Live', async () => {
    const extra = await headerTime();
    if (extra.some((t) => /back|link|start|live|pause|play|preview|×|range|moment/i.test(t))) fail(`time controls in the header: ${extra.join(', ')}`);
    const pill = (await view()).pill;
    if (pill !== 'Live') fail(`the pill reads "${pill}", not "Live"`);
    await openPanel();
    const shown = await panel.locator('button').allTextContents();
    if (await panel.locator('input[aria-label="Preview hour"]').count()) fail('the panel still has the time-of-day preview');
    await escape();
    if (await panel.isVisible().catch(() => false)) fail('Escape left the panel open');
    return `pill "${pill}"; panel: ${shown.join(', ')}`;
  });
  await step('Pause', async () => {
    await press(await moment('Pause'));
    const v = await until(async () => { const x = await view(); return x.pres === 'history' && /^Recorded · /.test(x.pill ?? '') ? x : null; }, 25000);
    if (!v) fail(`Pause did not hold the moment (presentation ${(await view()).pres})`);
    await sleep(2500);
    const after = await view();
    if (after.tick !== v.tick) fail(`the clock moved while paused (tick ${v.tick} -> ${after.tick})`);
    return `held at ${after.clock}; pill "${after.pill}"`;
  });
  await step('Play', async () => {
    const before = await view();
    await press(await moment('Play'));
    const v = await until(async () => { const x = await view(); return x.tick > before.tick ? x : null; }, 10000);
    if (!v) fail('Play did not move the clock');
    return `${before.clock} -> ${v.clock}`;
  });
  await step('Back 1 min', () => back('Back 1 min'));
  await step('Back again', () => back('Back again'));
  await step('From the start', async () => {
    const before = await view();
    await press(await moment('From the start'));
    const landed = await until(async () => { const bad = await notLoaded(); if (bad) return { bad }; const v = await view(); return v.pres === 'history' && v.tick < (before.tick ?? Infinity) ? v : null; }, 25000);
    if (!landed) fail('never landed on the first moment');
    if (landed.bad) fail(`"${landed.bad}"`);
    return `tick ${landed.tick}`;
  });
  await step('Link to this moment', async () => {
    const b = await moment('Link to this moment');
    await press(b);
    const link = await until(() => page.evaluate(() => document.querySelector('[data-moment-link]')?.getAttribute('data-moment-link') || null), 5000);
    if (!link) fail('no link was made');
    const said = await page.evaluate(() => document.querySelector('[data-moment-link]')?.textContent?.trim() ?? null);
    if (said !== 'Copied') fail(`the button says "${said}", not "Copied"`);
    const want = Math.floor(Number(new URLSearchParams(new URL(link).hash.slice(1)).get('t')) / 50000);
    const tab = await ctx.newPage();
    try {
      await tab.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const v = await until(async () => { const bad = await notLoaded(tab); if (bad) return { bad }; const x = await view(tab); return x.tick != null && x.pres === 'history' && !/Loading/.test(x.pill ?? '') ? x : null; }, 45000);
      if (!v) fail(`the link's tab never showed the moment (presentation ${(await view(tab)).pres})`);
      if (v.bad) fail(`the link's tab: "${v.bad}"`);
      // it plays on from the moment: within a few seconds after it, never before
      const off = (v.tick - want) * 0.05;
      if (off < -1 || off > 15) fail(`the link's tab shows ${off.toFixed(1)} s from the linked moment`);
      await tab.screenshot({ path: join(dir, 'moment-link-tab.png') }).catch(() => {});
      return `new tab at tick ${v.tick} (${off.toFixed(1)} s after the link's ${want}); pill "${v.pill}"`;
    } finally { await tab.close().catch(() => {}); }
  });
  await step('Return to live', async () => {
    await press(await moment('Return to live'));
    const v = await until(async () => { const x = await view(); return x.pres === 'live' && x.pill === 'Live' ? x : null; }, 20000);
    if (!v) fail(`never back to live (pill "${(await view()).pill}")`);
    await escape();
    return `pill "${v.pill}"`;
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
  await step('Follow a Soul', () => followSoul(page, { press, until, camera: async () => (await view()).camera }));
  if (!loadFailed) await escape();
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

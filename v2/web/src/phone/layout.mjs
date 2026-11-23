#!/usr/bin/env node
// The pages at phone width (Engine v2 W14, #3330). Loads each page at 375 × 812 (touch, mobile) and at 1440 × 900, opens
// its panels, and checks:
//  - A1: no horizontal overflow: the page does not scroll sideways and no visible element reaches past either edge;
//  - A2: at phone width, every visible control (link, button, field, select, a checkbox's label) is at least 44 × 44 px;
//  - A5: at 1440 × 900 the same overflow check passes (`--shots <dir>` writes each page's picture, to compare with main).
// The pages: the list of worlds (W3) and the front door's list (O19), a world's page with a Soul's page and the New Soul
// card open (W4, W11), the account page with My Souls (W9, W11), the approval card (W2), and the creator's panel (W5)
// where the branch has it. The directory's answers are fixtures (routed in the browser); the world's page plays a real
// stream from `worldd gateway-link` (built: cargo build -p worldd, and the WASM replica as v2/tools/ci.sh makes it).
//
//   node v2/web/src/phone/layout.mjs [--shots dir] [--only name,name] [--port 5190]
// Exit 0 when every page passes at both sizes; each failure is printed with the element and its size.
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const WEB = resolve(import.meta.dirname, '../..');
const V2 = resolve(WEB, '..');
const REPO = resolve(V2, '..');
const o = { shots: '', only: '', port: 5190 };
for (let i = 2; i < process.argv.length; i += 2) o[process.argv[i].slice(2)] = process.argv[i + 1];
const only = o.only ? new Set(o.only.split(',')) : null;

export const SIZES = {
  phone: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
const MIN = 44;

// The directory's answers.
const SOULS = [
  { soul: 'g-7-1', device: 'laptop-a', world: 'harbour', name: 'Oriel', description: 'keeps the lamps on the pier', picture: null, retire_asked: false },
  { soul: 'g-7-2', device: null, world: 'harbour', name: null, description: null, picture: null, retire_asked: true },
];
const WORLDS = { worlds: [
  { name: 'harbour', label: 'Gene', template: 'eden', awake: true, picture: null },
  { name: 'a-world-with-a-rather-long-name-for-a-phone', label: 'a creator with a long label', template: 'blank', awake: false, picture: null, closed: true },
], templates: ['eden', 'blank'] };
/** Routes the directory's answers on `page`, kept per page: a rename or a revoke shows on the next read. With `w`, the
 *  world `harbour` opens on w's stream (its `world.json`, as a placed world's page reads it). */
export async function route(page, w = null) {
  const souls = structuredClone(SOULS), mine = (b) => souls.find((s) => s.soul === b.soul);
  const answers = {
    'GET /v1/worlds': () => WORLDS,
    'GET /__sim/worlds.json': () => ({ worlds: [{ slug: 'eden', name: 'Eden', souls: 12 }] }),
    'POST /v1/account/souls': () => ({ souls }),
    'POST /v1/account/souls/profile': (b) => (Object.assign(mine(b), { name: b.name || null, description: b.description || null }), {}),
    'POST /v1/account/souls/revoke': (b) => ((mine(b).device = null), {}),
    'POST /v1/worlds/settings': () => ({ world: { name: 'harbour', label: 'Gene' } }),
    'POST /v1/pair/show': () => ({ code: 'WDJB-MJHT', device: 'a laptop called workbench-of-the-north', label: 'claude-code', soul: null, age: 42, connected: 'laptop-a', force: false }),
    'POST /v1/pair/approve': () => ({}),
    ...(w ? { 'GET /w/harbour/views/world.json': () => ({ stream: `/s/${w.stream}` }) } : {}),
  };
  await page.route(/\/(v1|__sim|w)\//, (r) => {
    const answer = answers[`${r.request().method()} ${new URL(r.request().url()).pathname}`];
    if (!answer) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"refused":"no-fixture"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer(r.request().postDataJSON() ?? {})) });
  });
}

/** A small world playing on the page: worldd's stream folder, its first body's id, and a stop. */
export async function world() {
  const worldd = join(V2, 'target/debug/worldd');
  if (!existsSync(worldd)) throw new Error(`${worldd}: build it first (cargo build -p worldd)`);
  const work = mkdtempSync(join(tmpdir(), 'v2-w14-'));
  const proc = spawn(worldd, ['gateway-link', '--socket', join(work, 'w.sock'), '--lineage', 'ce'.repeat(16), '--epoch', '1', '--log', join(work, 'log'),
    '--rooms', '1', '--bodies', '3', '--no-measures', '--www', join(work, 'www')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const bodies = [];
  const stream = await new Promise((ok, no) => {
    proc.once('exit', (c) => no(new Error(`worldd exited ${c}`)));
    createInterface({ input: proc.stdout }).on('line', (l) => (l.startsWith('body ') ? bodies.push(l.slice(5)) : l.startsWith('stream ') && ok(l.slice(7))));
  });
  return { www: join(work, 'www'), stream: `${stream}/`, soul: bodies[0].replace(/-(\d+)$/, '.$1'), stop: () => (proc.kill(), rmSync(work, { recursive: true, force: true })) };
}

export async function vite(www) {
  const proc = spawn(join(WEB, 'node_modules/.bin/vite'), ['--port', String(o.port), '--strictPort', '--host', '127.0.0.1'], { cwd: WEB, env: { ...process.env, V2_STREAM_DIR: www }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, no) => {
    proc.once('exit', (c) => no(new Error(`vite exited ${c}`)));
    createInterface({ input: proc.stdout }).on('line', (l) => l.includes(String(o.port)) && ok());
  });
  return proc;
}

/** Each page: its address and what opens its panels. */
export function pages(base, w) {
  const tap = async (p, sel) => ((await p.locator(sel).first().isVisible()) ? p.locator(sel).first().click() : null);
  const list = [
    { name: 'worlds', url: `${base}/src/worlds/`, ready: (p) => p.waitForSelector('#list a') },
    { name: 'home', url: `${base}/src/home/`, ready: (p) => p.waitForSelector('#list a') },
    {
      name: 'soul', url: `${base}/?stream=/s/${w.stream}&world=harbour&soul=${encodeURIComponent(w.soul)}`,
      ready: async (p) => {
        await p.waitForFunction(() => [...document.querySelectorAll('aside')].some((a) => a.style.display === 'block'), null, { timeout: 60_000 });
        await tap(p, 'button:text-is("New Soul")');
      },
    },
    {
      name: 'account', url: `${base}/src/account/?world=harbour`,
      ready: async (p) => {
        await p.fill('#person', 'gene');
        await p.click('#who button');
        await p.waitForSelector('li.mine');
        await p.waitForSelector('#settings:not([hidden])');
      },
    },
    {
      name: 'pairing', url: `${base}/src/pairing/card.html?code=WDJB-MJHT`,
      ready: async (p) => {
        await p.fill('#person', 'gene');
        await p.click('#who button');
        await p.waitForSelector('#card:not([hidden])');
      },
    },
  ];
  if (existsSync(join(WEB, 'src/panel/index.html'))) list.push({
    name: 'panel', url: `${base}/src/panel/?stream=/s/${w.stream}`,
    // The tools show once the gateway signs the creator in; here the layout is checked with them shown.
    ready: async (p) => {
      await p.waitForSelector('aside');
      await p.evaluate(() => document.body.classList.add('creator'));
    },
  });
  return list.filter((x) => !only || only.has(x.name));
}

/** What breaks the page at this size: overflow, and (on a phone) controls under 44 px. */
export function audit(page, phone) {
  return page.evaluate(({ phone, MIN }) => {
    const W = document.documentElement.clientWidth, out = [];
    const what = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${e.className && typeof e.className === 'string' ? `.${e.className.split(' ')[0]}` : ''} "${(e.getAttribute('aria-label') ?? e.textContent ?? e.value ?? '').trim().slice(0, 24)}"`;
    const shown = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    if (document.documentElement.scrollWidth > W + 1) out.push(`scrolls sideways: ${document.documentElement.scrollWidth} > ${W}`);
    for (const e of document.body.querySelectorAll('*')) {
      if (!shown(e) || e.tagName === 'CANVAS' || e.closest('[hidden]')) continue;
      const r = e.getBoundingClientRect();
      if (r.right > W + 1 || r.left < -1) out.push(`past the edge: ${what(e)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${W}`);
    }
    if (phone) for (const e of document.body.querySelectorAll('a[href], button, input, select, textarea, summary, [role=button]')) {
      if (e.type === 'hidden' || e.closest('[hidden]')) continue;
      // A checkbox is touched through its label.
      const t = (e.type === 'checkbox' || e.type === 'radio') && e.closest('label') ? e.closest('label') : e;
      if (!shown(t)) continue;
      const r = t.getBoundingClientRect();
      if (r.width < MIN - 0.5 || r.height < MIN - 0.5) out.push(`small: ${what(e)} is ${Math.round(r.width)} × ${Math.round(r.height)}`);
    }
    return [...new Set(out)];
  }, { phone, MIN });
}

async function main() {
  const { resolvePlaywright, browsersPath, launchArgs } = await import(pathToFileURL(join(REPO, 'tools/playtest/lib/platform.mjs')).href);
  browsersPath();
  const pw = resolvePlaywright();
  if (!pw) throw new Error('no Playwright (set PLAYTEST_PLAYWRIGHT_PKG to a package.json with @playwright/test)');
  const w = await world();
  const server = await vite(w.www);
  const browser = await pw.chromium.launch({ headless: true, args: launchArgs().args });
  if (o.shots) mkdirSync(o.shots, { recursive: true });
  let failed = 0;
  try {
    // A first load lets vite finish optimising the pages' modules (it reloads the page once); the checks start clean.
    const warm = await browser.newPage();
    for (const pg of pages(`http://127.0.0.1:${o.port}`, w)) await warm.goto(pg.url, { waitUntil: 'load' }).then(() => warm.waitForTimeout(3000));
    await warm.close();
    for (const [size, opts] of Object.entries(SIZES)) {
      for (const pg of pages(`http://127.0.0.1:${o.port}`, w)) {
        const ctx = await browser.newContext(opts);
        const page = await ctx.newPage();
        await route(page, w);
        await page.goto(pg.url, { waitUntil: 'domcontentloaded' });
        let bad;
        try {
          await pg.ready(page);
          await page.waitForTimeout(500);
          bad = await audit(page, size === 'phone');
        } catch (e) {
          bad = [`did not open: ${String(e.message ?? e).split('\n')[0]}`];
        }
        if (o.shots) await page.screenshot({ path: join(o.shots, `${pg.name}-${size}.png`) });
        console.log(`${bad.length ? 'FAIL' : 'ok  '} ${pg.name.padEnd(8)} ${size.padEnd(7)} ${opts.viewport.width}×${opts.viewport.height}`);
        for (const b of bad) console.log(`       ${b}`);
        failed += bad.length ? 1 : 0;
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
    w.stop();
  }
  process.exit(failed ? 1 : 0);
}

if (isMain(import.meta.url)) await main();

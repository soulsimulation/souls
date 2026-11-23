#!/usr/bin/env node
// 0.132's final check (F5, prepared in F5-prep): "Done when" lines 2 to 4 on a local Eden on the new engine, behind the
// local front door (v2/tools/ops/proxy/soul-game.caddy with this run's addresses, as v2/tools/dev/run.sh places it),
// switched with tools/world-launcher/v2-switch.mjs. Local only: loopback ports, fake minds, its own folder.
//
//   node tools/release/check-0132.mjs --bin <dir> --pkg <replica pkg> --card <new page build> [--facts <eden facts>]
//        [--agents 100] [--seconds 600] [--only 2,3,4] [--out <dir>] [--keep]
//
//   --bin    worldd, gatewayd, directoryd and driver, release builds of the head under check
//   --pkg    replica's wasm-bindgen package of the same head (target/wasm-load/pkg): the page's and the client's
//   --card   the new page's build (v2/web/dist): the front door serves the pairing card (/pair) from it
//   --facts  Eden's facts (v2/tools/import-eden/export/export.ts; exported here when not given)
//   --mars-web  the people's character set the old page draws (default mars/viewer/dist/client, `pnpm build:viewer`)
//   The old page is this checkout's apps/web/dist (`pnpm --filter web build`); caddy and node on PATH.
//
// 2. A freshly paired agent (the served client, v2/client/src/cli/souls.mjs, paired at /pair and approved in a real
//    browser by the local test person) walks, sits, lies, takes, carries, puts down, says and gestures; each must show
//    on the old page (its v2 reader's own view, window.__soulsV2) within 2 s of the command. One uncut clip of the page.
// 3. `--agents` seeded Souls driven for `--seconds` by the driver (loads.mjs mix-<n>-even-every4, --trace): from its
//    trace, intents never answered (ignored) and acts with no answer for 10 s (stuck); from the page, sampled every
//    chunk, pairs of bodies closer than 0.3 m in two chunks running (overlap for more than a moment).
// 4. A browser smoke: home, sign-in, sound, music, the camera.
// Prints a pass/fail table and writes report.json (and the clip) to the out folder. Exit 0 when every line passes.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BIN = resolve(opt('bin', join(repo, 'v2/target/release'))), PKG = resolve(opt('pkg', join(repo, 'v2/target/wasm-load/pkg')));
const CARD = resolve(opt('card', join(repo, 'v2/web/dist'))), AGENTS = Number(opt('agents', 100)), SECONDS = Number(opt('seconds', 600));
const MARS_WEB = resolve(opt('mars-web', join(repo, 'mars/viewer/dist/client')));
const ONLY = new Set(opt('only', '2,3,4').split(',')), KEEP = argv.includes('--keep');
const OUT = resolve(opt('out', join(repo, '.local/check-0132', new Date().toISOString().replace(/[:.]/g, '-'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`check-0132: ${s}`);
const need = (ok, what) => { if (!ok) { console.error(`check-0132: ${what}`); process.exit(2); } };
for (const b of ['worldd', 'gatewayd', 'directoryd', 'driver']) need(existsSync(join(BIN, b)), `--bin has no ${b}`);
need(existsSync(join(PKG, 'replica.js')), '--pkg has no replica.js');
need(existsSync(join(CARD, 'src/pairing/card.html')), '--card has no src/pairing/card.html (build v2/web)');
need(existsSync(join(repo, 'apps/web/dist/index.html')), 'apps/web/dist is not built');
need(existsSync(join(MARS_WEB, 'modular/humanoid/kit.json')), `--mars-web ${MARS_WEB} has no people's character set (pnpm build:viewer)`);
need(existsSync(join(repo, 'tools/world-launcher/v2-switch.mjs')), 'tools/world-launcher/v2-switch.mjs is missing (#4210)');
const FRONT = readFileSync(join(repo, 'v2/tools/ops/proxy/soul-game.caddy'), 'utf8');
need(/@pairing path \/v1\/pair\//.test(FRONT) && !/\(v2_world\)/.test(FRONT), 'the front door file is not the one that keeps the old home (#4248)');
const { chromium } = createRequire(join(repo, 'mars/viewer/package.json'))('@playwright/test');

mkdirSync(join(OUT, 'logs'), { recursive: true });
const procs = [];
const stop = () => { for (const p of procs) try { p.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));
/** Starts `cmd`, its output in logs/<name>.log; resolves with the first match of `ready` in it. */
function start(name, cmd, args, ready, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  procs.push(p);
  let out = '';
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(Error(`${name} not ready in 120 s: ${out.slice(-400)}`)), 120_000);
    const take = (d) => { out += d; writeFileSync(join(OUT, 'logs', `${name}.log`), out); const m = ready && ready.exec(out); if (m) { clearTimeout(t); ok(m); } };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('exit', (c) => { clearTimeout(t); no(Error(`${name} ended (${c}): ${out.slice(-400)}`)); });
    if (!ready) { clearTimeout(t); ok(null); }
  });
}
const freePort = async () => { const { createServer } = await import('node:net'); return new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); }); };
const json = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: await r.json().catch(() => null) }; };

// ---- the stack ----
const facts = opt('facts') ? resolve(opt('facts')) : join(OUT, 'eden-2026.facts.json');
if (!opt('facts')) { log('exporting Eden\'s facts'); execFileSync(process.execPath, ['v2/tools/import-eden/export/export.ts'], { cwd: repo, stdio: 'ignore' }); copyFileSync(join(repo, '.local/import-eden/eden-2026.facts.json'), facts); }
const W = join(OUT, 'world'), E = join(OUT, 'entries');
cpSync(join(repo, 'content/kinds'), E, { recursive: true });
log(`seeding Eden with ${AGENTS} test Souls`);
execFileSync(join(BIN, 'worldd'), ['seed', '--facts', facts, '--dir', W, '--entries', E, '--souls', String(AGENTS)], { stdio: ['ignore', 'ignore', 'ignore'] });
const keyFile = (n) => { const f = join(OUT, n); writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 }); return f; };
const viewKey = keyFile('view.key'), mailKey = keyFile('mailbox.key');
const port = { front: await freePort(), launcher: await freePort(), directory: await freePort(), gateway: await freePort(), origin: await freePort(), agents: await freePort() };
const BASE = `http://127.0.0.1:${port.front}`;
await start('worldd', join(BIN, 'worldd'), ['serve', '--dir', W, '--socket', `${W}.sock`], /./);
for (let i = 0; i < 600 && !existsSync(join(W, 'views/world.json')); i++) await sleep(100);
const stream = JSON.parse(readFileSync(join(W, 'views/world.json'), 'utf8')).stream;
await start('directoryd', join(BIN, 'directoryd'), ['--listen', `127.0.0.1:${port.directory}`, '--public-url', BASE, '--store', join(OUT, 'accounts.sqlite'),
  '--test-sign-in', '--pairing', join(OUT, 'pairing.sqlite'), '--gateway-tokens', join(W, 'tokens'), '--view-key', viewKey, '--mailbox-key', mailKey], /listening/);
await start('gatewayd', join(BIN, 'gatewayd'), ['--listen', `127.0.0.1:${port.gateway}`, '--world', `${W}.sock`, '--tokens', join(W, 'tokens'),
  '--build', `1220${'0'.repeat(64)}`, '--entries', join(W, 'entries'), '--view-key', viewKey, '--mailbox', `127.0.0.1:${port.directory}`, '--mailbox-key', mailKey], /listening/);
await start('origin', process.execPath, [join(repo, 'v2/tools/origin/origin.mjs'), W, String(port.origin), '127.0.0.1'], /^origin/m, { env: { ...process.env, ORIGIN_PROCESSES: '1' } });

// today's launcher (dev sign-in, fake minds) with old Eden 2026, bound for the switch
const binding = join(OUT, 'binding.json');
await start('launcher', process.execPath, [join(repo, 'tools/world-launcher/launcher.mjs'), '--port', String(port.launcher), '--data', join(OUT, 'launcher'), '--dev-auth',
  '--range', `${port.launcher + 100}-${port.launcher + 120}`, '--mars-web', MARS_WEB], /\[launcher\] http/, { env: { ...process.env, BRAIN_MODE: 'fake', SOULS_CUTOVER_BINDING: binding } });
const create = (template) => json(`http://127.0.0.1:${port.launcher}/__sim/worlds`, { method: 'POST', headers: { authorization: 'Bearer dev:Ada', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eden', template }) });
let made = await create('eden-2026');
if (!made.body?.slug) { log(`no eden-2026 template to create from (${made.status}); old Eden's scenery is eden-district's`); made = await create('eden-district'); }
need(made.body?.slug, `the launcher made no Eden: ${made.status} ${JSON.stringify(made.body).slice(0, 300)}`);
const SLUG = made.body.slug;
log(`old Eden is /w/${SLUG}/`);

// the routes file (the agents' relay and the switch read it), the relay, the switched slug's activation file
const routes = join(OUT, 'routes.json'), slugs = join(OUT, 'slugs');
writeFileSync(routes, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { [SLUG]: { gateway: `http://127.0.0.1:${port.gateway}`, stream: `/s/${stream.replace(/^\//, '')}`, canonical: false } } }));
mkdirSync(slugs); writeFileSync(join(slugs, SLUG), '');
await start('agents', process.execPath, [join(repo, 'v2/tools/origin/agents.mjs'), String(port.agents), '127.0.0.1'], /^agents/m, { env: { ...process.env, SOULS_WORLD_ROUTES: routes } });

// the front door, with this run's addresses and folders in place of the install's
const caddyDir = join(OUT, 'caddy'); mkdirSync(caddyDir);
writeFileSync(join(OUT, 'Caddyfile'), `{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n\tstorage file_system "${caddyDir}"\n}\n` + FRONT
  .replaceAll('https://soul.game', BASE).replaceAll('localhost:@@PRODUCTION_PORT@@', `127.0.0.1:${port.launcher}`)
  .replaceAll('localhost:7310', `127.0.0.1:${port.directory}`).replaceAll('localhost:7320', `127.0.0.1:${port.origin}`).replaceAll('localhost:7330', `127.0.0.1:${port.agents}`)
  .replaceAll('/usr/local/lib/souls/web', CARD).replaceAll('/var/lib/souls-routes/slugs', slugs)
  .replaceAll('/srv/sim-worlds/production/tools/world-launcher/deploy/caddy', join(repo, 'tools/world-launcher/deploy/caddy')));
await start('caddy', 'caddy', ['run', '--adapter', 'caddyfile', '--config', join(OUT, 'Caddyfile')], /serving initial configuration|server running/i, { env: { ...process.env, XDG_CONFIG_HOME: caddyDir, XDG_DATA_HOME: caddyDir } });

// the switch (#4210's one command)
const sw = JSON.parse(execFileSync(process.execPath, [join(repo, 'tools/world-launcher/v2-switch.mjs'), '--binding', binding, '--slug', SLUG, '--stream', `/s/${stream.replace(/^\//, '')}`,
  '--routes', routes, '--client', PKG, '--static', join(OUT, 'static'), '--port', String(port.launcher)], { encoding: 'utf8' }));
need(sw.page?.v2Stream, `the switch did not take: ${JSON.stringify(sw)}`);
log(`switched: ${BASE}/w/${SLUG}/ reads ${sw.page.v2Stream}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const report = { base: '<local front door>', world: SLUG, agents: AGENTS, seconds: SECONDS, lines: {} };
const rows = [];
const row = (line, what, pass, detail) => { rows.push({ line, what, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${line} ${what}: ${detail}`); };

/** The world page in the browser; `video` records it (uncut, real speed). */
async function worldPage(video) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(video ? { recordVideo: { dir: join(OUT, 'clip'), size: { width: 1280, height: 720 } } } : {}) });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept('Ada'));
  await page.goto(`${BASE}/w/${SLUG}/`);
  await page.waitForFunction(() => (window.__soulsV2?.parts ?? 0) > 0, null, { timeout: 60_000 }).catch(() => {});
  return { ctx, page };
}
/** What the page's v2 reader shows of one Soul now: its activity and held prop in the newest chunk, and its speech. */
const probe = (page, soul) => page.evaluate((soul) => {
  const v = window.__soulsV2; if (!v) return null;
  const s = v.souls.get(soul), chunk = v.takes.chunks.at(-1);
  const e = s && chunk ? chunk.take.finalState.entities[s.entityId] : null;
  const acts = new Set(); for (const c of v.takes.chunks.slice(-3)) for (const ch of c.take.changes ?? []) if (s && ch[1] === s.entityId && ch[2] === 'activity') acts.add(ch[3]);
  return { doing: s?.doing ?? null, activity: e?.human?.activity ?? null, acts: [...acts], prop: e?.human?.prop ?? null, said: v.speech.filter((x) => x.from?.soulId === soul).length, p: e?.pose?.p ?? null };
}, soul);

// ---- 2: a freshly paired agent ----
if (ONLY.has('2')) {
  // The agent's own home, named with SOULS_HOME: an empty .souls is not a home, and the client would walk up from here
  // to the nearest real one (a person's own Souls, when the checkout sits in their folder).
  const home = join(OUT, 'agent'); mkdirSync(join(home, '.souls'), { recursive: true });
  const cli = (...a) => { try { return JSON.parse(execFileSync(process.execPath, [join(repo, 'v2/client/src/cli/souls.mjs'), ...a], { cwd: home, encoding: 'utf8', env: { ...process.env, SOULS_HOME: join(home, '.souls'), SOULS_REPLICA_PKG: PKG }, timeout: 30_000 }).trim().split('\n').at(-1)); } catch (e) { const out = String(e.stdout ?? '').trim().split('\n').at(-1); try { return JSON.parse(out); } catch { return { ok: false, detail: String(out || e.message).slice(0, 300) }; } } };
  const { ctx, page } = await worldPage(true);
  const before = new Set(await page.evaluate(() => [...(window.__soulsV2?.souls.keys() ?? [])]));
  const pair = cli('pair', `${BASE}/${SLUG}?gateway=${BASE.replace(/^http/, 'ws')}/w/${SLUG}/v2/ws`);
  let connected = false;
  if (pair.link) {
    const card = await (await browser.newContext()).newPage();
    await card.goto(pair.link.replace(/^https?:\/\/[^/]+/, BASE));
    if (await card.locator('#signin').isVisible().catch(() => false)) await card.click('#signin');
    if (await card.locator('#who').isVisible().catch(() => false)) { await card.fill('#person', 'Ada'); await card.locator('#who button').click(); }
    await card.check('#match', { timeout: 15_000 }).catch(() => {});
    await card.click('#approve', { timeout: 15_000 }).catch(() => {});
    // the pairing finishes in the background (the client's own pair process): until then no Soul lives in the home
    for (let i = 0; i < 60 && !connected; i++) { connected = cli('status').connected === true; if (!connected) await sleep(1000); }
  }
  row(2, 'pair', connected, connected ? 'paired at /pair, approved in the card by the page\'s local sign-in, the client connected' : `pairing: ${JSON.stringify(pair).slice(0, 200)}`);
  report.lines[2] = { paired: connected, steps: [] };
  /** The first thing `find <word>` gives whose own offers include `<verb>:` (inspect), for each word in turn. */
  const offering = (verb, ...words) => {
    // outdoors first (on the ground: reachable from where a new Soul arrives), then the rest
    for (const w of words) for (const f of [...(cli('find', w).found ?? [])].sort((a, b) => /^ground/.test(b.in ?? '') - /^ground/.test(a.in ?? ''))) { const offers = JSON.stringify(cli('inspect', f.id)); if (offers.includes(`${verb}:${f.id}`) || offers.includes(`"${verb}:`)) return f.id; }
    return null;
  };
  /** Waits for act `seq` to end (its receipt, or a refusal), at most `ms`. */
  const ended = async (seq, ms = 120_000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1000)) { const r = cli('receipt', String(seq)).receipt; if (r && r.going === false) return r; } return null; };
  /** One timed step: the act sent, then the page polled until `shown` holds (at most 6 s); passes within 2 s. */
  let soul = null;
  const step = async (name, send, shown) => {
    const b = soul ? await probe(page, soul) : null, t0 = Date.now(), sent = send();
    let seenMs = null;
    while (Date.now() - t0 < 6000) {
      soul ??= (await page.evaluate(() => [...(window.__soulsV2?.souls.keys() ?? [])])).find((s) => !before.has(s)) ?? null;
      const s = soul ? await probe(page, soul) : null;
      if (s && shown(s, b ?? s)) { seenMs = Date.now() - t0; break; }
      await sleep(100);
    }
    const pass = sent?.ok !== false && seenMs !== null && seenMs <= 2000;
    // what the world answered so far (its receipt's phases or refusal, by name) and what the page showed last
    const answers = sent?.sequence ? (cli('receipt', String(sent.sequence)).receipt?.answers ?? []).map((a) => a.reason ?? a.answer).join(' > ') : '';
    const last = soul ? await probe(page, soul) : null;
    report.lines[2].steps.push({ name, answer: sent?.ok === false ? sent : { ok: true, sequence: sent?.sequence }, answers, seenMs, page: last });
    row(2, name, pass, `${sent?.ok === false ? `refused: ${JSON.stringify(sent).slice(0, 160)}` : `world: ${answers || 'no answer yet'}`}; on the page ${seenMs === null ? `not within 6 s (it shows ${last ? `${last.doing ?? '?'}, ${last.activity ?? '?'}${last.prop ? `, holding ${last.prop}` : ''}` : 'no such Soul'})` : `after ${seenMs} ms`}`);
    return sent;
  };
  const walking = (s) => s.doing === 'walking' || s.acts.includes('walk') || s.activity === 'walk';
  if (connected) {
    const bench = offering('sit', 'bench', 'chair'), bed = offering('lie', 'bed', 'hammock'), cup = offering('take', 'cup', 'book', 'apple', 'mug');
    report.lines[2].targets = { bench, bed, cup };
    // walk (the first act also brings the new Soul into the world: no join is taught or needed)
    let r = await step('walk', () => bench ? cli('act', bench) : { ok: false, detail: 'no seat found' }, walking);
    if (r?.sequence) await ended(r.sequence);
    r = await step('sit', () => bench ? cli('act', `sit:${bench}`) : { ok: false, detail: 'no seat found' }, (s) => s.activity === 'sit' || s.acts.includes('sit') || s.doing === 'seated');
    if (r?.sequence) await ended(r.sequence, 15_000);
    if (bed) { const w = cli('act', bed); if (w.sequence) await ended(w.sequence); }
    r = await step('lie', () => bed ? cli('act', `lie:${bed}`) : { ok: false, detail: 'no bed found' }, (s) => s.activity === 'lie' || s.acts.includes('lie'));
    if (r?.sequence) await ended(r.sequence, 15_000);
    if (cup) { const w = cli('act', cup); if (w.sequence) await ended(w.sequence); }
    r = await step('take', () => cup ? cli('act', `take:${cup}`) : { ok: false, detail: 'no thing to take found' }, (s) => !!s.prop);
    if (r?.sequence) await ended(r.sequence, 15_000);
    r = await step('carry', () => bench ? cli('act', bench) : { ok: false, detail: 'no place to carry it to' }, (s) => !!s.prop && walking(s));
    if (r?.sequence) await ended(r.sequence);
    const down = cup ? (JSON.stringify(cli('inspect', cup)).match(/"([a-z_-]+:(?:set-down|put-down|put|drop)(?::[^"]*)?)"/)?.[1] ?? 'hands:set-down') : null;
    r = await step('put down', () => down ? cli('act', down) : { ok: false, detail: 'nothing held' }, (s, b) => !!b.prop && !s.prop);
    if (r?.sequence) await ended(r.sequence, 15_000);
    await step('say', () => cli('say', 'Hello from the release check'), (s, b) => s.said > b.said);
    const body = cli('status').body ?? (soul ? (await page.evaluate((id) => window.__soulsV2.souls.get(id)?.entityId, soul))?.match(/^v2_([0-9a-f]{32})_(\d+)/)?.slice(1).join('-') : null);
    report.lines[2].body = body;
    await step('gesture', () => body ? cli('act', `wave:${body}`, `clap:${body}`) : { ok: false, detail: 'own body not known' }, (s) => s.acts.some((a) => /wave|clap|gesture/.test(a)) || /wave|clap/.test(s.activity ?? ''));
    await sleep(3000);
  }
  cli('quit'); // the agent's daemon is this run's: stopped by its own command
  await ctx.close(); // the clip is written on close
  report.clip = join(OUT, 'clip');
}
// ---- 4: a browser smoke of home, sign-in, sound, music, the camera ----
if (ONLY.has('4')) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } }), page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept('Ada'));
  const home = await page.goto(`${BASE}/`); await page.waitForTimeout(3000);
  row(4, 'home', home.status() === 200 && /Eden/.test(await page.locator('body').innerText()), `/ ${home.status()}, lists Eden: ${/Eden/.test(await page.locator('body').innerText())}`);
  await page.goto(`${BASE}/w/${SLUG}/`);
  await page.getByRole('button', { name: 'Audio' }).waitFor({ timeout: 60_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Sign in' }).first().click().catch(() => {}); await page.waitForTimeout(2000);
  const signedIn = !(await page.getByRole('button', { name: 'Sign in' }).count());
  row(4, 'sign-in', signedIn, signedIn ? 'the page\'s own sign-in (dev name on loopback)' : 'still signed out');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); } // the god panel opens for the world's creator
  await page.getByRole('button', { name: 'Audio', exact: true }).click().catch(() => {}); await page.waitForTimeout(4000);
  const menu = await page.locator('[aria-label="Audio"]').evaluateAll((els) => els.map((e) => e.innerText).join(' ').replace(/\s+/g, ' ')).catch(() => '');
  row(4, 'sound', /Sound effects On/i.test(menu), `the audio menu: ${menu.slice(0, 60) || 'not opened'}`);
  const track = menu.match(/Music (.*?) (?:Random track|Radio station)/)?.[1] ?? null;
  const next = page.getByRole('button', { name: 'Next track' });
  if (await next.count()) { await next.click().catch(() => {}); await page.waitForTimeout(3000); }
  const after = await page.locator('[aria-label="Audio"]').evaluateAll((els) => els.map((e) => e.innerText).join(' ').replace(/\s+/g, ' ')).catch(() => '');
  const track2 = after.match(/Music (.*?) (?:Random track|Radio station)/)?.[1] ?? null;
  row(4, 'music', !!track && !/off/i.test(track) && !!(await next.count()), `music: ${track ?? 'none'}, after Next track: ${track2 ?? 'none'}`);
  await page.keyboard.press('Escape');
  const label = () => page.getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') ?? '').find((l) => /: Switch to/.test(l)) ?? null).catch(() => null);
  const camBefore = await label();
  if (camBefore) await page.getByRole('button', { name: camBefore, exact: true }).click().catch(() => {}); await page.waitForTimeout(1500);
  const camAfter = await label();
  await page.getByRole('button', { name: /^Explore/ }).click().catch(() => {}); await page.waitForTimeout(1500);
  const someone = page.locator('text=/^Soul \\d+$/').filter({ visible: true }).first();
  let following = null;
  if (await someone.count()) { await someone.click().catch(() => {}); await page.waitForTimeout(2500); following = await page.getByRole('button', { name: /Following|Follow/ }).first().innerText().catch(() => null); }
  row(4, 'camera', !!camBefore && !!camAfter && camAfter !== camBefore, `${camBefore ?? 'no camera button'} -> ${camAfter ?? '?'}; a Soul's card: ${following ?? 'no Soul to follow'}`);
  await ctx.close();
}

// ---- 3: the seeded Souls driven, the page sampled ----
if (ONLY.has('3')) {
  const D = join(OUT, 'driver'); mkdirSync(D);
  execFileSync(process.execPath, [join(repo, 'v2/tools/driver/loads.mjs'), `mix-${AGENTS}-even-every4`, '--seconds', String(SECONDS), '--seed', '1', '--out', join(OUT, 'schedule.txt')], { stdio: 'ignore' });
  const { ctx, page } = await worldPage(false);
  const close = new Map(); const worst = { overlapChunks: 0, pair: null }; let overlapPairs = 0, samples = 0, lastTick = -1;
  const sampler = setInterval(async () => {
    const s = await page.evaluate(() => { const c = window.__soulsV2?.takes.chunks.at(-1); return c ? { tick: c.toTick, pts: Object.entries(c.take.finalState.entities).filter(([, e]) => e.human).map(([id, e]) => [id, e.pose.p]) } : null; }).catch(() => null);
    if (!s || s.tick === lastTick) return;
    lastTick = s.tick; samples++;
    const now = new Set();
    for (let i = 0; i < s.pts.length; i++) for (let j = i + 1; j < s.pts.length; j++) {
      const [a, p] = s.pts[i], [b, q] = s.pts[j];
      if (Math.hypot(p[0] - q[0], p[2] - q[2]) < 0.3 && Math.abs(p[1] - q[1]) < 1) {
        const k = `${a} ${b}`, n = (close.get(k) ?? 0) + 1; close.set(k, n); now.add(k);
        if (n === 2) overlapPairs++;
        if (n > worst.overlapChunks) { worst.overlapChunks = n; worst.pair = k; }
      }
    }
    for (const k of close.keys()) if (!now.has(k)) close.delete(k);
  }, 250);
  log(`driving ${AGENTS} Souls for ${SECONDS} s`);
  await start('driver', join(BIN, 'driver'), ['--schedule', join(OUT, 'schedule.txt'), '--dir', D, '--remote', `ws://127.0.0.1:${port.gateway}/v2/ws`, '--tokens', join(W, 'souls.tokens'),
    '--stream', `http://127.0.0.1:${port.origin}/${stream.replace(/^\//, '')}`, '--trace', join(OUT, 'trace.txt')], null);
  const driver = procs.at(-1);
  await new Promise((r) => driver.on('exit', r));
  clearInterval(sampler); await ctx.close();
  // the trace: `first <agent> <seq> <sent ms> <answered ms> <kind>`, `open <agent> <seq> <sent ms>`
  const trace = existsSync(join(OUT, 'trace.txt')) ? readFileSync(join(OUT, 'trace.txt'), 'utf8').split('\n') : [];
  const firsts = new Map(), opens = [];
  for (const l of trace) { const f = l.split(' '); if (f[0] === 'first') firsts.set(`${f[1]} ${f[2]}`, Number(f[4]) - Number(f[3])); else if (f[0] === 'open') opens.push(`${f[1]} ${f[2]}`); }
  const ignored = opens.filter((k) => !firsts.has(k));
  const slow = [...firsts].filter(([, ms]) => ms > 10_000).sort((a, b) => b[1] - a[1]);
  row(3, 'no two bodies overlap for more than a moment', overlapPairs === 0, `${overlapPairs} pairs closer than 0.3 m in two chunks running, over ${samples} chunks; worst ${worst.overlapChunks} chunks (${worst.pair ?? 'none'})`);
  row(3, 'no body ignores a new intent', ignored.length === 0 && firsts.size > 0, `${ignored.length} of ${firsts.size + ignored.length} intents never answered${ignored.length ? `; first: agent ${ignored[0]}` : ''}`);
  row(3, 'no Soul stuck over 10 s without a receipt saying why', slow.length === 0 && ignored.length === 0 && firsts.size > 0, `${slow.length} acts answered after more than 10 s (worst ${slow[0] ? `${Math.round(slow[0][1] / 1000)} s, agent ${slow[0][0]}` : 'none'}), ${ignored.length} never`);
  report.lines[3] = { overlapPairs, samples, worstOverlap: worst, intents: firsts.size + ignored.length, ignored: ignored.length, answeredAfter10s: slow.length, worstAnswerMs: slow[0]?.[1] ?? null };
}

await browser.close();
report.rows = rows;
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n| line | check | result | detail |\n|---|---|---|---|');
for (const r of rows) console.log(`| ${r.line} | ${r.what} | ${r.pass ? 'pass' : 'FAIL'} | ${r.detail.replaceAll('|', '/')} |`);
console.log(`\nreport: ${join(OUT, 'report.json')}${report.clip ? `; clip: ${report.clip}` : ''}`);
if (KEEP) { log('kept running (--keep); Ctrl-C stops everything'); await new Promise(() => {}); }
process.exit(rows.every((r) => r.pass) ? 0 : 1);

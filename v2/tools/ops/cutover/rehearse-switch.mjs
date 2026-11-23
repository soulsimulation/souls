#!/usr/bin/env node
// The switch rehearsed locally (0.134 F5-ready): the runbook's commands (v2/docs/cutover.md, "Switching a world's old
// page") run as written, each timed, on a fresh folder behind the local front door. Local only: loopback ports, fake
// minds, fake owners, its own folder; never production.
//
//   node v2/tools/ops/cutover/rehearse-switch.mjs --bin <dir> --pkg <replica pkg> [--facts <eden facts>] [--souls 3]
//        [--mars-web <dir>] [--out <dir>]
//
//   --bin     worldd, gatewayd and directoryd (release builds)
//   --pkg     replica's wasm-bindgen package (target/wasm-load/pkg)
//   --facts   Eden's facts (v2/tools/import-eden/export/export.ts; exported here when not given)
//   The old page is this checkout's apps/web/dist; caddy and node on PATH; Playwright from mars/viewer.
//
// The stack is check-0132's (tools/release/check-0132.mjs): Eden on the new engine (`worldd seed`, `serve`), its
// directory (test sign-in) with two fake accounts and a paired Soul, its gateway, the origin, the agents' relay,
// today's launcher with old Eden bound for the switch, and the front door (soul-game.caddy) on one port. Then, in order:
// stop the directory; save; wipe; start the directory; switch; look in a real browser; switch back; and how long
// until the old page is back. Prints the table and writes report.json. Exit 0 when every step passes.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BIN = resolve(opt('bin', join(repo, 'v2/target/release'))), PKG = resolve(opt('pkg', join(repo, 'v2/target/wasm-load/pkg')));
const MARS_WEB = resolve(opt('mars-web', join(repo, 'mars/viewer/dist/client'))), SOULS = Number(opt('souls', 3));
const OUT = resolve(opt('out', join(repo, '.local/rehearse-switch', new Date().toISOString().replace(/[:.]/g, '-'))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`rehearse-switch: ${s}`);
const need = (ok, what) => { if (!ok) { console.error(`rehearse-switch: ${what}`); process.exit(2); } };
for (const b of ['worldd', 'gatewayd', 'directoryd']) need(existsSync(join(BIN, b)), `--bin has no ${b}`);
need(existsSync(join(PKG, 'replica.js')), '--pkg has no replica.js');
need(existsSync(join(repo, 'apps/web/dist/index.html')), 'apps/web/dist is not built');
need(existsSync(join(MARS_WEB, 'modular/humanoid/kit.json')), `--mars-web ${MARS_WEB} has no people's character set`);
const FRONT = readFileSync(join(repo, 'v2/tools/ops/proxy/soul-game.caddy'), 'utf8');
const { chromium } = createRequire(join(repo, 'mars/viewer/package.json'))('@playwright/test');

mkdirSync(join(OUT, 'logs'), { recursive: true });
const procs = new Map();
const stopAll = () => { for (const p of procs.values()) try { p.kill(); } catch { /* gone */ } };
process.on('exit', stopAll);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));
function start(name, cmd, args, ready, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  procs.set(name, p);
  let out = '';
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(Error(`${name} not ready in 120 s: ${out.slice(-400)}`)), 120_000);
    const take = (d) => { out += d; writeFileSync(join(OUT, 'logs', `${name}.log`), out); if (ready.exec(out)) { clearTimeout(t); ok(); } };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('exit', (c) => { clearTimeout(t); if (procs.get(name) === p) no(Error(`${name} ended (${c}): ${out.slice(-400)}`)); });
  });
}
const stopOne = async (name) => { const p = procs.get(name); procs.delete(name); p.kill(); while (p.exitCode === null && p.signalCode === null) await sleep(20); };
const freePort = async () => { const { createServer } = await import('node:net'); return new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); }); };
const json = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: await r.json().catch(() => null) }; };
const node = (args) => execFileSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });

// ---- the stack (as check-0132) ----
const facts = opt('facts') ? resolve(opt('facts')) : join(OUT, 'eden-2026.facts.json');
if (!opt('facts')) { log('exporting Eden\'s facts'); execFileSync(process.execPath, ['v2/tools/import-eden/export/export.ts', '--out', facts], { cwd: repo, stdio: 'ignore' }); }
const W = join(OUT, 'world'), E = join(OUT, 'entries');
cpSync(join(repo, 'content/kinds'), E, { recursive: true });
log(`seeding Eden with ${SOULS} Souls`);
execFileSync(join(BIN, 'worldd'), ['seed', '--facts', facts, '--dir', W, '--entries', E, '--souls', String(SOULS)], { stdio: 'ignore' });
const keyFile = (n) => { const f = join(OUT, n); writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 }); return f; };
const viewKey = keyFile('view.key'), mailKey = keyFile('mailbox.key');
const port = { front: await freePort(), launcher: await freePort(), directory: await freePort(), gateway: await freePort(), origin: await freePort(), agents: await freePort() };
const BASE = `http://127.0.0.1:${port.front}`;
await start('worldd', join(BIN, 'worldd'), ['serve', '--dir', W, '--socket', `${W}.sock`], /listening/);
const stream = `/s/${JSON.parse(readFileSync(join(W, 'views/world.json'), 'utf8')).stream.replace(/^\/?/, '')}`;
// The directory as production names it: its arguments in one file (directory.args), its gateway tokens the world's.
const accounts = join(OUT, 'accounts.sqlite'), pairing = join(OUT, 'pairing.sqlite'), tokens = join(W, 'tokens');
const dirArgs = ['--listen', `127.0.0.1:${port.directory}`, '--public-url', BASE, '--store', accounts, '--test-sign-in', '--pairing', pairing,
  '--gateway-tokens', tokens, '--view-key', viewKey, '--mailbox-key', mailKey];
const argsFile = join(OUT, 'directory.args');
writeFileSync(argsFile, `DIRECTORYD_ARGS="${dirArgs.join(' ')}"\n`);
const directory = () => start('directoryd', join(BIN, 'directoryd'), dirArgs, /listening/);
await directory();
await start('gatewayd', join(BIN, 'gatewayd'), ['--listen', `127.0.0.1:${port.gateway}`, '--world', `${W}.sock`, '--tokens', tokens,
  '--build', `1220${'0'.repeat(64)}`, '--entries', join(W, 'entries')], /listening/);
await start('origin', process.execPath, [join(repo, 'v2/tools/origin/origin.mjs'), W, String(port.origin), '127.0.0.1'], /^origin/m, { env: { ...process.env, ORIGIN_PROCESSES: '1' } });
const binding = join(OUT, 'binding.json');
await start('launcher', process.execPath, [join(repo, 'tools/world-launcher/launcher.mjs'), '--port', String(port.launcher), '--data', join(OUT, 'launcher'), '--dev-auth',
  '--range', `${port.launcher + 100}-${port.launcher + 120}`, '--mars-web', MARS_WEB], /\[launcher\] http/, { env: { ...process.env, BRAIN_MODE: 'fake', SOULS_CUTOVER_BINDING: binding } });
const create = (template) => json(`http://127.0.0.1:${port.launcher}/__sim/worlds`, { method: 'POST', headers: { authorization: 'Bearer dev:Ada', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eden', template }) });
let made = await create('eden-2026');
if (!made.body?.slug) made = await create('eden-district');
need(made.body?.slug, `the launcher made no Eden: ${made.status}`);
const SLUG = made.body.slug;
const routes = join(OUT, 'routes.json'), slugs = join(OUT, 'slugs');
writeFileSync(routes, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { [SLUG]: { gateway: `http://127.0.0.1:${port.gateway}`, stream, canonical: false } } }));
mkdirSync(slugs); writeFileSync(join(slugs, SLUG), '');
await start('agents', process.execPath, [join(repo, 'v2/tools/origin/agents.mjs'), String(port.agents), '127.0.0.1'], /^agents/m, { env: { ...process.env, SOULS_WORLD_ROUTES: routes } });
const caddyDir = join(OUT, 'caddy'), card = join(OUT, 'card'); mkdirSync(caddyDir); mkdirSync(card);
writeFileSync(join(OUT, 'Caddyfile'), `{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n\tstorage file_system "${caddyDir}"\n}\n` + FRONT
  .replaceAll('https://soul.game', BASE).replaceAll('localhost:@@PRODUCTION_PORT@@', `127.0.0.1:${port.launcher}`)
  .replaceAll('localhost:7310', `127.0.0.1:${port.directory}`).replaceAll('localhost:7320', `127.0.0.1:${port.origin}`).replaceAll('localhost:7330', `127.0.0.1:${port.agents}`)
  .replaceAll('/usr/local/lib/souls/web', card).replaceAll('/var/lib/souls-routes/slugs', slugs)
  .replaceAll('/srv/sim-worlds/production/tools/world-launcher/deploy/caddy', join(repo, 'tools/world-launcher/deploy/caddy')));
await start('caddy', 'caddy', ['run', '--adapter', 'caddyfile', '--config', join(OUT, 'Caddyfile')], /serving initial configuration|server running/i, { env: { ...process.env, XDG_CONFIG_HOME: caddyDir, XDG_DATA_HOME: caddyDir } });

// Fake owners in the directory's stores: two accounts and one paired Soul (the directory stopped while they go in).
await stopOne('directoryd');
const a = new DatabaseSync(accounts);
a.exec("INSERT INTO provider_accounts_v1 VALUES ('acc_fake_ada', 'https://issuer.test', 'user_ada', unixepoch()), ('acc_fake_bo', 'https://issuer.test', 'user_bo', unixepoch())");
a.close();
const p = new DatabaseSync(pairing);
p.exec("INSERT INTO paired_souls_v1 VALUES ('soul:fake', 'acc_fake_ada', 'laptop', 'aa')");
p.close();
await directory();
log(`stack up: old Eden /w/${SLUG}/ behind ${BASE}, the new Eden's stream ${stream}`);

// ---- the runbook, each step timed ----
const rows = [];
const timed = async (step, command, fn) => {
  const t = performance.now();
  let pass = false, detail;
  try { ({ pass, detail } = await fn()); } catch (e) { detail = String(e.message ?? e).slice(0, 300); }
  const ms = Math.round(performance.now() - t);
  rows.push({ step, command, ms, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${step} (${ms} ms): ${detail}`);
};
const saved = join(OUT, 'project', 'cutover', `eden-owners-${new Date().toISOString().replace(/[:.]/g, '-')}.tar`);
await timed('stop the directory', 'systemctl stop souls-directory', async () => { await stopOne('directoryd'); return { pass: true, detail: 'stopped' }; });
await timed('save', `node v2/tools/ops/cutover/souls-state.mjs save --args <directory.args> --world <world> --out <saved .tar>`, async () => {
  const r = JSON.parse(node(['v2/tools/ops/cutover/souls-state.mjs', 'save', '--args', argsFile, '--world', W, '--out', saved]));
  return { pass: r.ok && r.counts.accounts === 2 && r.counts.soulsPaired === 1 && r.counts.worldSouls === SOULS, detail: JSON.stringify(r.counts) };
});
await timed('wipe', `node v2/tools/ops/cutover/souls-state.mjs wipe --args <directory.args> --saved <saved .tar>`, async () => {
  const r = JSON.parse(node(['v2/tools/ops/cutover/souls-state.mjs', 'wipe', '--args', argsFile, '--saved', saved]));
  return { pass: r.ok && !existsSync(accounts) && readFileSync(tokens, 'utf8') === '', detail: `${r.aside.length} files renamed aside` };
});
await timed('start the directory', 'systemctl start souls-directory', async () => {
  await directory();
  // The directory holds its stores while it runs: fresh means it made new ones where the wipe left none.
  // (it writes the gateway's tokens file whole from its store: a header and no Soul).
  const souls = readFileSync(tokens, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
  const fresh = existsSync(accounts) && existsSync(pairing) && souls === 0;
  return { pass: fresh, detail: `listening on fresh stores; ${souls} Soul tokens` };
});
await timed('switch', `node tools/world-launcher/v2-switch.mjs --slug ${SLUG} --stream ${stream} --routes <routes.json> --client <client dir> --static <static dir> --port <launcher port>`, async () => {
  const sw = JSON.parse(node(['tools/world-launcher/v2-switch.mjs', '--binding', binding, '--slug', SLUG, '--stream', stream, '--routes', routes, '--client', PKG,
    '--static', join(OUT, 'static'), '--port', String(port.launcher)]));
  return { pass: sw.page?.v2Stream === stream, detail: `the page names ${sw.page?.v2Stream}` };
});
const GL = process.platform === 'darwin' ? 'metal' : 'soft';
const browser = await chromium.launch({ args: [...(GL === 'metal' ? ['--use-angle=metal', '--enable-gpu'] : ['--use-gl=angle', '--use-angle=swiftshader']), '--ignore-gpu-blocklist'] });
const look = async (shot) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/w/${SLUG}/`);
  // Drawn: the page's toolbar is up once its loading screen is gone; then a moment for the scene to settle.
  const drawn = await page.getByText('Broadcast').first().waitFor({ timeout: 90_000 }).then(() => true, () => false);
  await sleep(4000);
  return { ctx, page, drawn, shot: async () => page.screenshot({ path: join(OUT, shot) }) };
};
await timed('look in a real browser', `open ${'<front door>'}/w/${SLUG}/: the page reads the new engine's stream`, async () => {
  const { ctx, page, drawn, shot } = await look('switched.png');
  const ok = await page.waitForFunction(() => (window.__soulsV2?.parts ?? 0) > 0, null, { timeout: 60_000 }).then(() => true, () => false);
  const parts = await page.evaluate(() => window.__soulsV2?.parts ?? 0);
  await shot(); await ctx.close();
  return { pass: ok && drawn, detail: `drawn ${drawn}, ${parts} stream parts read (switched.png)` };
});
let backAt = 0;
await timed('switch back', `node tools/world-launcher/v2-switch.mjs --back --slug ${SLUG} --port <launcher port>`, async () => {
  backAt = performance.now();
  const r = JSON.parse(node(['tools/world-launcher/v2-switch.mjs', '--binding', binding, '--back', '--slug', SLUG, '--port', String(port.launcher)]));
  return { pass: !r.page?.v2Stream, detail: `the page names ${r.page?.v2Stream ?? 'no stream'}` };
});
await timed('the old page is back', `open ${'<front door>'}/w/${SLUG}/: no v2Stream, the old world answers, the page draws it`, async () => {
  let html = '';
  for (let i = 0; i < 600; i++) { html = await (await fetch(`${BASE}/w/${SLUG}/`)).text(); if (!/v2Stream/.test(html)) break; await sleep(100); }
  const { ctx, page, drawn, shot } = await look('switched-back.png');
  const v2 = await page.evaluate(() => window.__soulsV2?.parts ?? 0);
  const snapshot = (await fetch(`${BASE}/w/${SLUG}/v1/world/snapshot`)).status;
  await shot(); await ctx.close();
  const within = Math.round((performance.now() - backAt) / 1000);
  return { pass: !/v2Stream/.test(html) && drawn && v2 === 0 && snapshot === 200 && within <= 60, detail: `back ${within} s after the command: page without v2Stream, canvas drawn, no stream parts, old snapshot ${snapshot} (switched-back.png)` };
});
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ world: SLUG, stream, souls: SOULS, rows }, null, 2) + '\n');
console.log('\n| step | command | time | result |\n|---|---|---:|---|');
for (const r of rows) console.log(`| ${r.step} | \`${r.command}\` | ${(r.ms / 1000).toFixed(1)} s | ${r.pass ? 'pass' : 'FAIL'}: ${r.detail} |`);
const pass = rows.every((r) => r.pass);
console.log(`\nrehearse-switch: ${pass ? 'PASS' : 'FAIL'} (${OUT})`);
process.exit(pass ? 0 : 1);

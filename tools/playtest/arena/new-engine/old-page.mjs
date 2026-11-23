#!/usr/bin/env node
// The old page (apps/web) on a local new-engine world, in one command (0.135 P5). Until the old page draws ground and
// buildings from the stream alone (0.135 W2), its shell comes from the world launcher's copy of the same template, and
// `tools/world-launcher/v2-switch.mjs` points that page at the new engine, as on soul.game:
//
//   1. `v2/tools/dev/run.sh --facts`: the new engine's world from the template (world.mjs), its gateway, directory and
//      origin; its Souls are paired and act there (seat.mjs).
//   2. the launcher (dev sign-in, fake minds, its data under this run's folder) makes the template's old world, the
//      page's shell: its scenery, its sky and its web app.
//   3. a second front door, the production one (`v2/tools/ops/proxy/soul-game.caddy`) with this run's addresses, routes
//      that world's page to the launcher and its stream, agents and pairing to run.sh's programs.
//   4. `v2-switch.mjs` binds the world to the new engine's stream (run.sh's routes file gains its entry).
//
//   node tools/playtest/arena/new-engine/old-page.mjs [--template worlds/templates/hello-hamlet.json] [--dir <folder>]
//
// It prints `ready <url>` (the old page of the world), and runs until stopped (Ctrl-C or SIGTERM), which stops everything
// it started. A recorder sets its picture's time of day with `?hour=HH:MM` on that address (the light only; the world's
// clock is the engine's). Needs a built apps/web (`pnpm --filter web build`), the people's character set
// (`pnpm build:viewer`, or --mars-web), caddy and what run.sh needs. Loopback only, fake minds, never a production world.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isMain } from '../../../lib/is-main.mjs';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { sleep } from '../../lib/clock.mjs';
import { freePorts, startWorld, stopWorld } from './world.mjs';
import { REPLICA_PKG } from './seat.mjs';

export const FRONT_FILE = join(REPO_ROOT, 'v2/tools/ops/proxy/soul-game.caddy');
export const MARS_WEB = join(REPO_ROOT, 'mars/viewer/dist/client');
const LAUNCHER = join(REPO_ROOT, 'tools/world-launcher/launcher.mjs');
const SWITCH = join(REPO_ROOT, 'tools/world-launcher/v2-switch.mjs');
const CLIENT_BUILD = join(REPO_ROOT, 'v2/client/served/build.mjs');

/** The production front door with this run's addresses and folders in place of the install's (as check-0132 builds it). */
export function frontDoor(front, { base, launcher, directory, origin, web, slugs, caddyDir }) {
  return `{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n\tdefault_bind 127.0.0.1\n\tstorage file_system "${caddyDir}"\n}\n` + front
    .replaceAll('https://soul.game', base).replaceAll('localhost:@@PRODUCTION_PORT@@', `127.0.0.1:${launcher}`)
    .replaceAll('localhost:7310', directory).replaceAll('localhost:7320', origin).replaceAll('localhost:7330', origin)
    .replaceAll('/usr/local/lib/souls/web', web).replaceAll('/var/lib/souls-routes/slugs', slugs)
    .replaceAll('/srv/sim-worlds/production/tools/world-launcher/deploy/caddy', join(REPO_ROOT, 'tools/world-launcher/deploy/caddy'));
}

/** run.sh's routes file with `slug` routed like its own world (`dev`): the same gateway, stream and history. */
export function withRoute(routes, slug, from = 'dev') {
  const dev = routes.worlds?.[from];
  if (!dev) throw new Error(`the routes file has no ${from}`);
  return { ...routes, worlds: { ...routes.worlds, [slug]: { ...dev, canonical: false } } };
}

/** The template's name as the launcher knows it (`worlds/templates/<name>.json`). */
export const templateName = (template) => basename(template).replace(/\.json$/, '');

function start(name, cmd, args, ready, { dir, env = {} }) {
  const log = join(dir, 'logs', `${name}.log`), out = openSync(log, 'a');
  const p = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', out], detached: true });
  let text = '';
  p.stdout.on('data', (d) => { text += d; writeFileSync(log, text); });
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`${name} not ready in 180 s: ${text.slice(-300)}`)), 180_000);
    const check = setInterval(() => { if (!ready || ready.test(text) || ready.test(safeRead(log))) { clearTimeout(t); clearInterval(check); ok(p); } }, 100);
    p.on('exit', (c) => { clearTimeout(t); clearInterval(check); no(new Error(`${name} ended (${c}): ${safeRead(log).slice(-300)}`)); });
  });
}
const safeRead = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const kill = (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } };

/** Brings the old page up on a new-engine world of `template`. → {page, slug, world, stop()} */
export async function startOldPage({ template = 'worlds/templates/hello-hamlet.json', dir, marsWeb = MARS_WEB, pkg = REPLICA_PKG, log = () => {} } = {}) {
  dir = resolve(dir);
  for (const [f, what] of [[join(REPO_ROOT, 'apps/web/dist/index.html'), 'apps/web is not built (pnpm --filter web build)'],
    [join(marsWeb, 'modular/humanoid/kit.json'), `${marsWeb} has no people's character set (pnpm build:viewer)`], [join(pkg, 'replica.js'), `no replica package at ${pkg}`]]) {
    if (!existsSync(f)) throw new Error(what);
  }
  const front = readFileSync(FRONT_FILE, 'utf8');
  if (!/@pairing path \/v1\/pair\//.test(front)) throw new Error('the front door file is not the one that keeps the old home (#4248)');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const procs = [];
  let world = null;
  const stop = async () => { for (const p of procs.reverse()) kill(p); if (world) await stopWorld(world); };
  try {
    world = await startWorld({ template, dir: join(dir, 'world') });
    log(`new engine: ${world.page} (${(world.bootMs / 1000).toFixed(1)} s)`);
    const port = await freePorts(world.port ?? undefined), launcher = port + 1, frontPort = port;
    const binding = join(dir, 'binding.json');
    procs.push(await start('launcher', process.execPath, [LAUNCHER, '--port', String(launcher), '--data', join(dir, 'launcher'), '--dev-auth',
      '--range', `${launcher + 100}-${launcher + 120}`, '--mars-web', marsWeb], /\[launcher\] http/, { dir, env: { BRAIN_MODE: 'fake', SOULS_CUTOVER_BINDING: binding, SOULS_V2_DIRECTORY: world.directory } }));   // MS: My Souls reads a moved world's Souls there
    const made = await fetch(`http://127.0.0.1:${launcher}/__sim/worlds`, { method: 'POST', headers: { authorization: 'Bearer dev:Ada', 'content-type': 'application/json' },
      body: JSON.stringify({ name: templateName(template), template: templateName(template) }) }).then((r) => r.json());
    if (!made?.slug) throw new Error(`the launcher made no world from ${templateName(template)}: ${JSON.stringify(made).slice(0, 300)}`);
    const slug = made.slug;
    log(`old page's shell: /w/${slug}/`);

    const routesFile = join(world.dir, 'routes.json');
    const routes = withRoute(JSON.parse(readFileSync(routesFile, 'utf8')), slug);
    writeFileSync(`${routesFile}.tmp`, JSON.stringify(routes)); renameSync(`${routesFile}.tmp`, routesFile);
    const slugs = join(dir, 'slugs'), caddyDir = join(dir, 'caddy');
    mkdirSync(slugs, { recursive: true }); mkdirSync(caddyDir, { recursive: true }); writeFileSync(join(slugs, slug), '');
    const base = `http://127.0.0.1:${frontPort}`;
    writeFileSync(join(dir, 'Caddyfile'), frontDoor(front, { base, launcher, directory: world.directory.replace('http://', ''), origin: world.origin.replace('http://', ''),
      web: join(REPO_ROOT, 'v2/web/dist'), slugs, caddyDir }));
    procs.push(await start('caddy', process.env.CADDY ?? 'caddy', ['run', '--adapter', 'caddyfile', '--config', join(dir, 'Caddyfile')], null,
      { dir, env: { XDG_CONFIG_HOME: caddyDir, XDG_DATA_HOME: caddyDir } }));
    for (let i = 0; i < 100; i++) { if (await fetch(`${base}/__sim/healthz`).then((r) => r.ok, () => false)) break; await sleep(100); }

    // the client the switched page serves its agents (the launcher checks it before it routes the page)
    const client = join(dir, 'client');
    execFileSync(process.execPath, [CLIENT_BUILD, '--out', client, '--version', '0.0.0', '--pkg', pkg], { cwd: REPO_ROOT, stdio: 'ignore' });
    const sw = JSON.parse(execFileSync(process.execPath, [SWITCH, '--binding', binding, '--slug', slug, '--stream', routes.worlds[slug].stream,
      '--routes', routesFile, '--client', client, '--static', join(dir, 'static'), '--port', String(launcher)], { cwd: REPO_ROOT, encoding: 'utf8' }));
    if (!sw.page?.v2Stream) throw new Error(`the switch did not take: ${JSON.stringify(sw).slice(0, 300)}`);
    const page = `${base}/w/${slug}/`;
    // the page's inline config names the stream once the launcher has the binding (within a second)
    let routed = false;
    const names = async (u) => /"v2Stream"/.test(await fetch(u, { headers: { accept: 'text/html' } }).then((r) => r.text(), () => ''));
    for (let i = 0; i < 100 && !(routed = (await names(page)) || (await names(`${page}v1/config`))); i++) await sleep(200);
    if (!routed) throw new Error(`the page at /w/${slug}/ does not name the stream: ${await fetch(`${page}v1/config`).then((r) => r.text(), (e) => e.message).then((t) => t.slice(0, 200))}`);
    return { page, slug, base, world, stop };
  } catch (e) { await stop(); throw e; }
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const run = await startOldPage({ template: opt('template'), dir: opt('dir', join(REPO_ROOT, '.local/old-page', stamp)), marsWeb: opt('mars-web', MARS_WEB), log: (s) => console.error(`old-page: ${s}`) })
    .catch((e) => { console.error(`old-page: ${e.message}`); process.exit(1); });
  const quit = async () => { await run.stop(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  console.log(`ready ${run.page}`);
  console.log(`new engine ${run.world.page}   directory ${run.world.directory}   gateway ${run.world.gateway}`);
  setInterval(() => {}, 1 << 30);
}

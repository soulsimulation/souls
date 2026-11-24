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
//   node tools/playtest/arena/new-engine/old-page.mjs [--template worlds/templates/hello-hamlet.json] [--dir <folder>] [--create]
//
// --create (0.135 W1): no old world at all. The launcher makes worlds on the new engine (on wherever it has a binding): the
// home page's New world goes to the directory's create as the signed-in person, and the world is served at /w/<slug>/
// and listed once its route is registered. Locally the create and its placement are `localCreate` (below): the
// directory's create contract (`POST /v1/worlds`, `world-starting` until placed), the creator the person the directory
// signs in, and the world placed by routing its name like run.sh's world (its gateway and stream), as placement's
// route does on soul.game (v2/tools/ops/place-created-world.mjs). It prints `ready <url>`: the home page.
//
// It prints `ready <url>` (the old page of the world), and runs until stopped (Ctrl-C or SIGTERM), which stops everything
// it started. A recorder sets its picture's time of day with `?hour=HH:MM` on that address (the light only; the world's
// clock is the engine's). Needs a built apps/web (`pnpm --filter web build`), the people's character set
// (`pnpm build:viewer`, or --mars-web), caddy and what run.sh needs. Loopback only, fake minds, never a production world.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isMain } from '../../../lib/is-main.mjs';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { sleep } from '../../lib/clock.mjs';
import { WORLD, freePorts, startWorld, stopWorld } from './world.mjs';
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

/** The directory programs run.sh runs (its `BIN`: V2_BIN, else the Cargo target's debug folder). */
const v2Bin = () => process.env.V2_BIN ?? join(process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, 'v2/target'), 'debug');

/** With history on, run.sh's world keeps its records in a folder store and reads its one creator from the directory's
 *  record there (worldd `serve.rs` `creator`), which nothing in a local run writes: every creator edit would be refused
 *  `edit.not-the-creator`. So the world is registered there (`register-world`, as an imported world is on soul.game)
 *  under run.sh's name for it, its creator the one it was seeded with (Ada), and this waits until worldd has read it
 *  (it reads the record again every 30 s). */
export async function registerCreator(world, { waitMs = 60_000 } = {}) {
  const seeded = JSON.parse(readFileSync(join(world.dir, 'world/world.json'), 'utf8'));
  if (!seeded.name || !seeded.creator) throw new Error('the seeded world names no instance or creator');
  const register = join(v2Bin(), 'register-world');
  if (!existsSync(register)) throw new Error(`no ${register} (cargo build -p directoryd --bin register-world)`);
  execFileSync(register, [WORLD, '--instance', seeded.name, '--creator', seeded.creator], {
    env: { ...process.env, DIRECTORYD_WORLD_STORE: join(world.dir, 'store') }, stdio: ['ignore', 'ignore', 'pipe'] });
  // worldd says `creator: <hex>:<n>` (the directory's form of the seeded `<hex>-<n>`) when it has read it
  const said = `creator: ${seeded.creator.replace(/-(\d+)$/, ':$1')}`, log = join(world.dir, 'logs/worldd.log');
  for (const end = Date.now() + waitMs; !safeRead(log).split('\n').includes(said);) {
    if (Date.now() > end) throw new Error(`worldd did not read its creator in ${waitMs / 1000} s: ${safeRead(log).slice(-300)}`);
    await sleep(250);
  }
}
const kill = (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } };

/** The genesis both sides start from. A committed template (`worlds/templates/<name>.json`) is used as it is; any other
 *  file, or a template with `add` (god ops, as a template's batches hold them: things placed before the world starts),
 *  is written into this run's own templates folder, which the launcher is given (`--templates-dir`).
 *  → {template: the file run.sh's export reads, name, templatesDir: null | the run's folder} */
export function genesisFor({ template, add = [], dir }) {
  const file = resolve(REPO_ROOT, template), name = templateName(file), g = JSON.parse(readFileSync(file, 'utf8'));
  // a committed template the launcher offers is used as it is; one it hides from creation (Eden 2026: `hidden`) is
  // offered from the run's own folder, unhidden, as the old clip worlds booted any template as their genesis
  if (!add.length && !g.hidden && resolve(file, '..') === join(REPO_ROOT, 'worlds/templates')) return { template: file, name, templatesDir: null };
  delete g.hidden;
  if (add.length) g.batches = [...(g.batches ?? []), { note: 'a staged scene\'s things (0.135 P3)', ops: add }];
  const templatesDir = join(dir, 'templates');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, `${name}.json`), JSON.stringify(g));
  return { template: join(templatesDir, `${name}.json`), name, templatesDir };
}

/** W1 locally: the directory's create (`POST /v1/worlds`, v2/crates/directoryd/src/worlds/list/http.rs) and placement in
 *  one stand-in in front of run.sh's directory. A create is answered `world-starting` once for its key (placement under
 *  way), then placed: its name routed like run.sh's world in the routes file (canonical) and activated in the front
 *  door's `slugs` folder, the row's creator the principal run.sh's directory signs that test person in as. `GET
 *  /v1/worlds` lists what was made; every other ask goes to run.sh's directory as it is. Only `template` is offered.
 *  → {url, rows, close()} */
export async function localCreate({ directory, routesFile, slugs, template, from = WORLD }) {
  const rows = new Map(), placing = new Set();
  const answer = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === '/v1/worlds' && req.method === 'GET') return answer(res, 200, { worlds: [...rows.values()].map((m) => m.row), templates: [template] });
    if (req.url !== '/v1/worlds' || req.method !== 'POST') {
      const r = await fetch(`${directory}${req.url}`, { method: req.method, headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), 'content-type': req.headers['content-type'] ?? 'application/json' },
        ...(body.length ? { body } : {}) }).catch(() => null);
      if (!r) return answer(res, 502, { refused: 'directory-unreachable' });
      return res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
    }
    const person = /^Bearer test:(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!person) return answer(res, 401, { refused: 'token-missing' });
    let ask; try { ask = JSON.parse(body.toString('utf8')); } catch { return answer(res, 400, { refused: 'bad-json' }); }
    if (ask.template !== template) return answer(res, 409, { refused: 'template-missing', detail: ask.template });
    if (!/^(?!-)[a-z0-9-]{1,40}(?<!-)$/.test(ask.name ?? '')) return answer(res, 409, { refused: 'name-not-allowed', detail: String(ask.name) });
    const made = rows.get(ask.name);
    if (made) return made.key === ask.key ? answer(res, 200, { world: made.row, epoch: 1 }) : answer(res, 409, { refused: 'name-taken', detail: ask.name });
    if (!placing.has(ask.key)) { placing.add(ask.key); return answer(res, 503, { refused: 'world-starting', detail: '' }); }
    const who = await fetch(`${directory}/v1/account/test-sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: person }) }).then((r) => r.json(), () => null);
    if (!who?.principal) return answer(res, 503, { refused: 'store-unreachable', detail: '' });
    const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
    const next = { ...routes, worlds: { ...routes.worlds, [ask.name]: { ...routes.worlds[from], canonical: true } } };
    writeFileSync(`${routesFile}.tmp`, JSON.stringify(next)); renameSync(`${routesFile}.tmp`, routesFile);
    writeFileSync(join(slugs, ask.name), '');
    const row = { name: ask.name, label: ask.label, template, creator: who.principal, made: Math.floor(Date.now() / 1000), ready: true };
    rows.set(ask.name, { key: ask.key, row });
    return answer(res, 200, { world: row, epoch: 1 });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, rows, close: () => server.close() };
}

/** Brings the old page up on a new-engine world of `template` (with `add`'s things placed), or of `facts` (the template's
 *  facts, edited: the engine's world; the template stays the page's shell). → {page, slug, world, stop()} */
export async function startOldPage({ template = 'worlds/templates/hello-hamlet.json', add = [], facts = null, dir, marsWeb = MARS_WEB, pkg = REPLICA_PKG, history = true, create = false, log = () => {} } = {}) {
  dir = resolve(dir);
  const genesis = genesisFor({ template, add, dir });
  for (const [f, what] of [[join(REPO_ROOT, 'apps/web/dist/index.html'), 'apps/web is not built (pnpm --filter web build)'],
    [join(marsWeb, 'modular/humanoid/kit.json'), `${marsWeb} has no people's character set (pnpm build:viewer)`], [join(pkg, 'replica.js'), `no replica package at ${pkg}`]]) {
    if (!existsSync(f)) throw new Error(what);
  }
  const front = readFileSync(FRONT_FILE, 'utf8');
  if (!/@pairing path \/v1\/pair\//.test(front)) throw new Error('the front door file is not the one that keeps the old home (#4248)');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const procs = [];
  let world = null;
  let creating = null;
  const stop = async () => { for (const p of procs.reverse()) kill(p); creating?.close(); if (world) await stopWorld(world); };
  try {
    world = await startWorld({ template: genesis.template, facts, dir: join(dir, 'world'), history });
    log(`new engine: ${world.page} (${(world.bootMs / 1000).toFixed(1)} s)`);
    if (history) await registerCreator(world);
    const port = await freePorts(world.port ?? undefined), launcher = port + 1, frontPort = port;
    const binding = join(dir, 'binding.json');
    if (create) return await withCreate({ world, genesis, dir, marsWeb, pkg, launcher, frontPort, binding, front, procs, stop, setMade: (m) => { creating = m; }, log });
    procs.push(await start('launcher', process.execPath, [LAUNCHER, '--port', String(launcher), '--data', join(dir, 'launcher'), '--dev-auth',
      '--range', `${launcher + 100}-${launcher + 120}`, '--mars-web', marsWeb, ...(genesis.templatesDir ? ['--templates-dir', genesis.templatesDir] : [])], /\[launcher\] http/, { dir, env: { BRAIN_MODE: 'fake', SOULS_CUTOVER_BINDING: binding, SOULS_V2_DIRECTORY: world.directory } }));   // MS: My Souls reads a moved world's Souls there
    const made = await fetch(`http://127.0.0.1:${launcher}/__sim/worlds`, { method: 'POST', headers: { authorization: 'Bearer dev:Ada', 'content-type': 'application/json' },
      body: JSON.stringify({ name: genesis.name, template: genesis.name }) }).then((r) => r.json());
    if (!made?.slug) throw new Error(`the launcher made no world from ${genesis.name}: ${JSON.stringify(made).slice(0, 300)}`);
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

/** W1 (--create): the launcher with no old world, making worlds on the new engine through `localCreate`. Its binding
 *  binds run.sh's own world (so the launcher has the routes file and client a world with no old twin is served with);
 *  that world is not listed. → {page: the home page, slug: null, base, world, made, stop} */
async function withCreate({ world, genesis, dir, marsWeb, pkg, launcher, frontPort, binding, front, procs, stop, setMade, log }) {
  const routesFile = join(world.dir, 'routes.json'), slugs = join(dir, 'slugs'), caddyDir = join(dir, 'caddy');
  mkdirSync(slugs, { recursive: true }); mkdirSync(caddyDir, { recursive: true });
  const made = await localCreate({ directory: world.directory, routesFile, slugs, template: genesis.name });
  setMade(made);
  const client = join(dir, 'client');
  execFileSync(process.execPath, [CLIENT_BUILD, '--out', client, '--version', '0.0.0', '--pkg', pkg], { cwd: REPO_ROOT, stdio: 'ignore' });
  const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
  execFileSync(process.execPath, [SWITCH, '--binding', binding, '--slug', WORLD, '--stream', routes.worlds[WORLD].stream, '--routes', routesFile, '--client', client,
    '--static', join(dir, 'static')], { cwd: REPO_ROOT, stdio: 'ignore' });
  procs.push(await start('launcher', process.execPath, [LAUNCHER, '--port', String(launcher), '--data', join(dir, 'launcher'), '--dev-auth',
    '--range', `${launcher + 100}-${launcher + 120}`, '--mars-web', marsWeb, ...(genesis.templatesDir ? ['--templates-dir', genesis.templatesDir] : [])], /\[launcher\] http/,
    { dir, env: { BRAIN_MODE: 'fake', SOULS_CUTOVER_BINDING: binding, SOULS_V2_DIRECTORY: made.url } }));
  const base = `http://127.0.0.1:${frontPort}`;
  writeFileSync(join(dir, 'Caddyfile'), frontDoor(front, { base, launcher, directory: world.directory.replace('http://', ''), origin: world.origin.replace('http://', ''),
    web: join(REPO_ROOT, 'v2/web/dist'), slugs, caddyDir }));
  procs.push(await start('caddy', process.env.CADDY ?? 'caddy', ['run', '--adapter', 'caddyfile', '--config', join(dir, 'Caddyfile')], null,
    { dir, env: { XDG_CONFIG_HOME: caddyDir, XDG_DATA_HOME: caddyDir } }));
  for (let i = 0; i < 100; i++) { if (await fetch(`${base}/__sim/healthz`).then((r) => r.ok, () => false)) break; await sleep(100); }
  log(`new worlds on the new engine: ${base}/ (New world, template ${genesis.name})`);
  return { page: `${base}/`, slug: null, base, world, made, stop };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const run = await startOldPage({ template: opt('template'), dir: opt('dir', join(REPO_ROOT, '.local/old-page', stamp)), marsWeb: opt('mars-web', MARS_WEB), create: argv.includes('--create'), log: (s) => console.error(`old-page: ${s}`) })
    .catch((e) => { console.error(`old-page: ${e.message}`); process.exit(1); });
  const quit = async () => { await run.stop(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  console.log(`ready ${run.page}`);
  console.log(`new engine ${run.world.page}   directory ${run.world.directory}   gateway ${run.world.gateway}`);
  setInterval(() => {}, 1 << 30);
}

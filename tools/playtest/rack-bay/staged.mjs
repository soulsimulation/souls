#!/usr/bin/env node
// The headline demo on a staged world, in one command: four humanoid Souls in a new Mars College camp, each driven by
// its own agent's Soul client, build a pallet rack bay together and take it down, filmed uncut at real speed on the
// old page from a fixed camera. Everything goes the way a real owner and real agents go, against any site:
//
//   1. the owner makes the world with the home page's New world (`POST /__sim/worlds`, template `mars-camp`), signed
//      in; it is unlisted at once (`/v1/worlds/settings`), a staged world, not a public one (--listed keeps it listed)
//   2. a creator folder fetches the client the world serves (`<world>/eden.mjs`) and pairs as its creator
//      (`node eden.mjs god pair <world> --creator <the owner's creator grant>`); the owner approves the code
//   3. if the world has no rack yard of the construction kinds, the creator places one in one `god batch`
//      (rack-bay.mjs `stageLive`), 6 m south of the template's own (its frames' posts would stop a carry)
//   4. four agent folders (ada, bo, cy, di), each its own `eden.mjs` and its own daemon, `pair <world>`; the owner
//      approves each code; each names its Soul (`profile name`) and joins (`act life:join --wait`)
//   5. the build and the take-down (rack-bay.mjs `buildAndTakeDown`), every step one Soul's own command line, while
//      the old page is recorded (launch-video/capture.mjs) from a fixed camera on the yard
//   6. a report: commands, refusals, time, the world, the clip. Every daemon this started is ended; the world stays.
//
// On soul.game (after the release that carries the live-placed stand fix, #4733, and the Mars look, #4730):
//
//   node tools/playtest/rack-bay/staged.mjs --site https://soul.game [--name "Rack bay staged"] [--record 300]
//
//   The owner is whoever is signed in to the site in the browser window this opens: a browser profile of its own,
//   kept at .local/rack-bay-staged/owner-profile (--profile), opened with Playwright's Chromium, never installed
//   Chrome (as tools/first-day opens its profiles), so the first run waits up to 10 minutes for you to sign in there
//   as the world's owner (sign-in is never typed by this script) and later runs are already signed in. Each
//   owner request is made in that page, with its own session token (Clerk's), as the page's own buttons make them.
//   The window may be minimised; do not close it until the run ends.
//
// Locally, the same steps against the prod-like stack (tools/playtest/arena/new-engine/old-page.mjs --create: run.sh's
// programs, the launcher, the production front door with this run's addresses), the owner the test person Ada:
//
//   node tools/playtest/rack-bay/staged.mjs --local [--record 300]
//
//   Needs what old-page.mjs needs: run.sh's programs (cargo build), the replica package, apps/web and the viewer built,
//   caddy on PATH. Fake minds only; loopback only.
//
// Options: --dir <folder> (default .local/rack-bay-staged/<stamp>), --record <seconds> (0: no clip; default 300),
// --size 1280x720, --hour 12:00 (the clip's light), --listed. Output: <dir>/report.json (the steps, each with its
// answer), <dir>/rack-bay.mp4 and its sidecar, each folder's commands.jsonl. Tokens stay in each folder's .souls/
// (mode 600) and are never printed. Exit 0 when the bay was built and taken down with 0 refused.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { isMain } from '../../lib/is-main.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { AT, CAMERA, buildAndTakeDown, findIds, runner, stageLive } from './rack-bay.mjs';

export const TEMPLATE = 'mars-camp';
export const LABELS = ['ada', 'bo', 'cy', 'di'];
/** The live yard's offset from the template's (metres south): the template's own yard may stand as plain things. */
export const LIVE_SOUTH = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The yard and the camera `dz` metres south. */
export function southOf(dz, at = AT, camera = CAMERA) {
  const p = ([x, z]) => [x, z + dz];
  return {
    at: { stand: p(at.stand), beams: at.beams.map(p), bay: p(at.bay), spare: p(at.spare) },
    camera: { ...camera, position: [camera.position[0], camera.position[1], camera.position[2] + dz], target: [camera.target[0], camera.target[1], camera.target[2] + dz] },
  };
}

/** Every JSON line of a command's output, in order. */
export const jsonLines = (text) => String(text).split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((j) => j && typeof j === 'object');

/** The owner's creator grant (`creator-<hex>-<n>`, one per person, for every world they make) among what the
 *  directory says they own (`/v1/account/view-token`'s `owned`, the exchange the old page makes; the front door sends
 *  it to the directory). */
export function creatorGrantOf(owned) {
  const g = (owned ?? []).map((o) => o.grant).filter((x) => /^creator-[0-9a-f]{32}-\d+$/.test(x ?? ''));
  if (g.length !== 1) throw new Error(g.length ? `the owner holds ${g.length} creator grants` : 'the directory names no creator grant for the owner (is the world made?)');
  return g[0];
}

// ------------------------------------------------------------------------------------------------ the owner

/** The owner on a real site: the person signed in in a browser profile of its own. Each request is made in the page
 *  with a fresh session token, as the page's own requests are. → {post(path, body), owned(), close()} */
export async function browserOwner(site, profile, log) {
  const { chromium } = createRequire(join(REPO_ROOT, 'mars/viewer/package.json'))('@playwright/test');
  mkdirSync(profile, { recursive: true });
  const open = (o) => chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1100, height: 800 }, ...o });
  // Playwright's Chromium only, as tools/first-day opens its profiles: installed Chrome keeps cookies under another
  // keychain key, cannot read a Chromium profile's sign-in, and rewrites its cookies, signing the owner out
  const context = await open({});
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(site, { waitUntil: 'domcontentloaded' });
  const signedIn = () => page.evaluate(async () => !!(await window.Clerk?.session?.getToken?.().catch(() => null)));
  if (!(await signedIn().catch(() => false))) {
    log('sign in as the world\'s owner in the browser window this opened (waiting up to 10 minutes)');
    for (const end = Date.now() + 600_000; !(await signedIn().catch(() => false));) {
      if (Date.now() > end) { await context.close(); throw new Error('no one signed in to the owner window in 10 minutes'); }
      await sleep(2000);
    }
  }
  await page.goto(site, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 60 && !(await signedIn().catch(() => false)); i++) await sleep(500);
  const post = (path, body = {}) => page.evaluate(async ([path, body]) => {
    const token = await window.Clerk.session.getToken({ skipCache: true });
    const r = await fetch(path, { method: 'POST', credentials: 'omit', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let b = null; try { b = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: b ?? {} };
  }, [path, body]);
  return { post, owned: async () => (await post('/v1/account/view-token')).body.owned, close: () => context.close() };
}

/** The owner on the local stack: the test person, signed in as the launcher's dev sign-in and the directory's test
 *  sign-in (the same requests, a test person's credentials in place of a session token). */
export function testOwner(site, name = 'Ada') {
  const post = async (path, body = {}) => {
    const launcher = path.startsWith('/__sim/');
    const r = await fetch(new URL(path, site), { method: 'POST', headers: { 'content-type': 'application/json', ...(launcher ? { authorization: `Bearer dev:${name}` } : {}) },
      body: JSON.stringify(launcher ? body : { ...body, test_person: name, name }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { post, owned: async () => (await post('/v1/account/view-token')).body.owned, close: async () => {} };
}

/** The home page's New world, asked again with its key and address while the world starts (launcher.mjs
 *  `createOnNewEngine`). → the world's address (slug) */
export async function newWorld(owner, { name, template = TEMPLATE, log = () => {}, waitMs = 600_000 }) {
  let ask = { name, template };
  for (const end = Date.now() + waitMs; ;) {
    const { status, body } = await owner.post('/__sim/worlds', ask);
    if (status === 201 && body.slug) return body.slug;
    if ((status === 202 || status === 503) && body.key && body.slug) { ask = { name, template, key: body.key, slug: body.slug }; log(`new world ${body.slug}: ${body.code ?? status}`); }
    else throw new Error(`New world was refused ${status} ${body.code ?? ''}: ${body.message ?? JSON.stringify(body).slice(0, 200)}`);
    if (Date.now() > end) throw new Error(`the world ${ask.slug} did not start in ${waitMs / 1000} s`);
    await sleep(Math.max(1, body.retry_after ?? 2) * 1000);
  }
}

// ------------------------------------------------------------------------------------------------ agents' folders

/** One agent's folder: the client the world serves, fetched as an agent fetches it (`curl -fsSO <world>/eden.mjs`),
 *  its home `.souls` in the folder. `cli(...words)` runs `node eden.mjs <words>` there; each command and its answer
 *  goes to the folder's commands.jsonl. */
export async function agentFolder(world, folder) {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'eden.mjs');
  if (!existsSync(file)) {
    const r = await fetch(new URL('eden.mjs', world));
    if (!r.ok) throw new Error(`${world}eden.mjs answered ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  const home = join(folder, '.souls'), log = join(folder, 'commands.jsonl');
  // only what an agent's shell has: never a launcher variable or a model key; the home named so no folder above is used
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SOULS_HOME: home, BRAIN_MODE: 'fake' };
  const run = (words, ms = 120_000) => new Promise((ok) => {
    const t = Date.now(), p = spawn(process.execPath, [file, ...words], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), ms);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      clearTimeout(kill);
      const lines = jsonLines(out), answer = lines.at(-1) ?? { ok: false, raw: (out + err).slice(-400) };
      appendFileSync(log, JSON.stringify({ at: t, ms: Date.now() - t, words, answer }) + '\n');
      ok({ answer, lines });
    });
  });
  return { folder, home, cli: async (...words) => (await run(words)).answer, run };
}

/** A pairing as an agent asks it: the link and code (`pair` or `god pair`'s first answer), the owner's approval, then
 *  the pairing's own outcome in the home's pairing.log. → the paired id (`s_…` or `c_…`) */
export async function pairFolder(agent, words, owner, { waitMs = 120_000 } = {}) {
  const { lines } = await agent.run(words);
  const asked = lines.find((j) => typeof j.code === 'string' && j.code && j.ok !== false);
  if (!asked) throw new Error(`${words.join(' ')}: no pairing code (${JSON.stringify(lines.at(-1) ?? {}).slice(0, 200)})`);
  const a = await owner.post('/v1/pair/approve', { code: asked.code, confirm: true });
  if (a.status !== 200) throw new Error(`the owner's approval answered ${a.status} ${a.body.refused ?? ''}`);
  for (const end = Date.now() + waitMs; Date.now() < end; await sleep(250)) {
    let text = ''; try { text = readFileSync(join(agent.home, 'pairing.log'), 'utf8'); } catch { /* not yet */ }
    const done = jsonLines(text).find((j) => j.ok === true && typeof j.soul === 'string');
    if (done) return done.soul;
    const failed = jsonLines(text).find((j) => j.ok === false);
    if (failed) throw new Error(`pairing failed: ${failed.code ?? ''} ${failed.detail ?? ''}`);
  }
  throw new Error(`pairing did not finish in ${waitMs / 1000} s after approval`);
}

/** One agent's Soul: paired, named and joined. → {cli, body, soul, folder} */
export async function soulSeat(world, folder, owner, name, log) {
  const agent = await agentFolder(world, folder);
  const soul = await pairFolder(agent, ['pair', world], owner);
  const named = await agent.cli('profile', 'name', name);
  if (!named.ok) log(`${name}: profile name answered ${named.code ?? JSON.stringify(named).slice(0, 120)}`);
  const joined = await agent.cli('act', 'life:join', '--wait');
  let body = null;
  for (let i = 0; i < 120 && !body; i++) { body = (await agent.cli('status')).body ?? null; if (!body) await sleep(250); }
  if (!body) throw new Error(`${name}: no body after joining (${JSON.stringify(joined).slice(0, 200)})`);
  return { ...agent, soul, body, quit: () => agent.cli('quit') };
}

/** The creator's folder: `god pair`, approved by the owner; `god(...words)` answers as rack-bay.mjs's creator does. */
export async function creatorSeat(world, folder, owner) {
  const agent = await agentFolder(world, folder);
  await pairFolder(agent, ['god', 'pair', world, '--creator', creatorGrantOf(await owner.owned())], owner);
  const god = async (...words) => (await agent.run(['god', ...words])).answer;
  for (let i = 0; i < 120 && !(await god('status')).connected; i++) await sleep(500);
  god.quit = () => agent.run(['god', 'quit']);
  return god;
}

// ------------------------------------------------------------------------------------------------ the run

/** The steps against one site. → the report (also written to <dir>/report.json) */
export async function staged({ site, owner, dir, name, record = 300, size = '1280x720', hour = '12:00', listed = false, log = console.error }) {
  const t0 = Date.now(), out = { site, started: new Date(t0).toISOString(), template: TEMPLATE, steps: [] };
  const save = () => writeFileSync(join(dir, 'report.json'), JSON.stringify(out, null, 1));
  const seats = {};
  let god = null;
  try {
    out.slug = await newWorld(owner, { name, log });
    out.world = `${site.replace(/\/$/, '')}/w/${out.slug}/`;
    out.createdS = (Date.now() - t0) / 1000; save();
    log(`world ${out.world} (${out.createdS.toFixed(0)} s)`);
    if (!listed) {
      // the directory's switch (its creator's), else the launcher's (the world's owner); a staged world is not listed
      const u = await owner.post('/v1/worlds/settings', { world: out.slug, unlisted: true });
      const v = u.status === 200 ? u : await owner.post(`/__sim/worlds/${out.slug}/unlisted`, { unlisted: true });
      out.unlisted = v.status === 200;
      log(out.unlisted ? 'unlisted' : `unlisting answered ${u.status} ${u.body.refused ?? ''} and ${v.status} ${v.body.code ?? ''}: the world stays listed`);
    }
    god = await creatorSeat(out.world, join(dir, 'creator'), owner);
    // the template's yard when the world has it in the construction kinds, else one placed live by the creator
    const kinds = ((await god('describe')).nodes ?? []).map((n) => n.kind);
    let yard = { at: AT, camera: CAMERA };
    if (kinds.includes('mars:rack_bay')) out.stage = 'template';
    else {
      yard = southOf(LIVE_SOUTH);
      out.stage = 'live';
      out.staged = await stageLive(god, log, yard.at); save();
      if (!out.staged.ok) throw new Error(`the creator's staging was refused: ${JSON.stringify(out.staged.failed).slice(0, 300)}`);
    }
    out.yard = yard; log(`yard: ${out.stage}`);
    for (const l of LABELS) {
      seats[l] = await soulSeat(out.world, join(dir, 'agents', l), owner, l[0].toUpperCase() + l.slice(1), log);
      log(`${l}: ${seats[l].soul}, body ${seats[l].body}`);
    }
    out.bodies = Object.fromEntries(LABELS.map((l) => [l, seats[l].body]));
    out.ids = await findIds(seats.ada); out.readyS = (Date.now() - t0) / 1000; save();
    const play = async () => {
      const p0 = Date.now(), r = runner(seats, (s) => log(s), p0); out.steps = r.lines;
      try { const v = await buildAndTakeDown(r, out.bodies, out.ids, yard.at.beams.map((b) => b.join(','))); out.builtAtS = (v.built - p0) / 1000; out.ok = true; }
      catch (e) { out.ok = false; out.failed = e.message; }
      out.playS = (Date.now() - p0) / 1000; save();
    };
    if (record > 0) {
      const { capture } = await import('../../launch-video/capture.mjs');
      const { cameraShot } = await import('../../launch-video/scene.mjs');
      const [w, h] = size.split('x').map(Number);
      let playing = null;
      out.clip = { file: join(dir, 'rack-bay.mp4'), camera: yard.camera, seconds: record };
      out.clip.sidecar = await capture({ url: out.world, remote: true, out: out.clip.file, seconds: record, size, hour,
        shot: cameraShot({ fixed: yard.camera }, record, w / h), log, onPlay: () => { playing = play(); } });
      await playing;
    } else await play();
  } catch (e) { out.ok = false; out.failed ??= e.message; }
  finally {
    for (const s of Object.values(seats)) await s.quit().catch(() => null);
    await god?.quit().catch(() => null);
    out.commands = out.steps.length; out.refused = out.steps.filter((s) => !s.ok).length; out.totalS = (Date.now() - t0) / 1000;
    save();
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const local = argv.includes('--local'), site = opt('site', null);
  if (!local && !/^https:\/\//.test(site ?? '')) { console.error('usage: staged.mjs --site https://soul.game [--name n] [--record s] [--dir d] [--profile p] [--listed] | --local [--record s]'); process.exit(2); }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const dir = resolve(opt('dir', join(REPO_ROOT, '.local/rack-bay-staged', stamp)));
  mkdirSync(dir, { recursive: true });
  const log = (s) => console.error(`staged: ${s}`);
  let stack = null, owner = null, report = null;
  try {
    if (local) {
      const { startOldPage } = await import('../arena/new-engine/old-page.mjs');
      stack = await startOldPage({ template: `worlds/templates/${TEMPLATE}.json`, dir: join(dir, 'stack'), create: true, history: false, marsWeb: opt('mars-web', undefined), log });
      owner = testOwner(stack.base);
    } else owner = await browserOwner(site, resolve(opt('profile', join(REPO_ROOT, '.local/rack-bay-staged/owner-profile'))), log);
    report = await staged({ site: local ? stack.base : site, owner, dir, name: opt('name', `Rack bay ${stamp.slice(4, 8)}`), record: Number(opt('record', 300)),
      size: opt('size', '1280x720'), hour: opt('hour', '12:00'), listed: argv.includes('--listed'), log });
  } finally { await owner?.close(); await stack?.stop(); }
  const r = report;
  console.log(JSON.stringify({ ok: !!r?.ok, world: r?.world, stage: r?.stage, commands: r?.commands, refused: r?.refused, builtAtS: r?.builtAtS, playS: r?.playS, totalS: r?.totalS,
    failed: r?.failed, clip: r?.clip?.file ?? null, report: join(dir, 'report.json') }, null, 1));
  process.exit(r?.ok ? 0 : 1);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(`staged: ${e.stack ?? e.message}`); process.exit(1); });

// A picture of the world, drawn on the agent's own machine (Engine v2 G10, #2800). Carried over from today's `shoot`
// (#2260, docs/architecture/souls.md "Eyes"): the site's own page in a headless browser here, anonymous (no token, no
// sign-in, cookies cleared, the address stripped of any sign-in parameter), its profile under the home keeping the
// page's assets between shots. The world renders nothing. The page names what it plays (`v2/web/src/capture/`) and
// puts the camera on a named place, Soul or thing, or behind a Soul's own eyes; it plays only the public stream, so a
// shot holds nothing a visitor could not see. A shot of a past moment is V9's link: give the page's address with its
// `#w=…&l=…&t=…` fragment.
//
// With no browser on the machine, the answer is words instead: why, and R7's brief from the Soul's daemon (its room,
// what is in it, the places around), with what `find` says of the name.
//
// The creator sets the world's picture on the list (W3) from a shot: `picture` sends the file to the directory, which
// runs G6's check and keeps it as one field of the world's row.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

export const NO_BROWSER = 'No headless browser on this machine, so shoot cannot draw here. Install one with `npm i -g playwright && npx playwright install chromium` (or set SOULS_PLAYWRIGHT to a folder whose node_modules has playwright).';
export const USAGE = 'shoot <place|soul|thing> [--eyes] [--page <url>] [--out file.png|.jpg] [--size WxH]  |  shoot picture <file> --world <name> --directory <url> --as <test name>';
/** Page parameters that would sign the browser in; a shot is anonymous, so they never reach it. */
export const SIGN_IN_PARAMS = ['directory', 'gateway', 'as', 'token'];
/** A shot waits at most this long for the page's first drawn frame, ms. */
const READY_MS = 20_000;

const fail = (code, detail) => Object.assign(new Error(detail), { code });

/** The arguments as a shot, or `picture`'s upload. Throws the usage on anything it does not know. */
export function parseShoot(args) {
  const o = { name: null, eyes: false, page: null, out: null, size: [1280, 720], picture: null, world: null, directory: null, as: null };
  const need = (i) => { const v = args[i + 1]; if (v === undefined || v.startsWith('--')) throw fail('usage', `${args[i]} needs a value. ${USAGE}`); return v; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--eyes') o.eyes = true;
    else if (['--page', '--out', '--world', '--directory', '--as'].includes(a)) o[a.slice(2)] = need(i), i++;
    else if (a === '--size') {
      const m = /^(\d{2,4})x(\d{2,4})$/.exec(need(i)); i++;
      if (!m || +m[1] < 64 || +m[2] < 64 || +m[1] > 1920 || +m[2] > 1920) throw fail('usage', '--size is WxH, 64 to 1920');
      o.size = [+m[1], +m[2]];
    } else if (a.startsWith('--')) throw fail('usage', `unknown option ${a}. ${USAGE}`);
    else if (o.name === null && a === 'picture' && i === 0) o.picture = true;
    else if (o.picture === true) o.picture = a;
    else if (o.name === null) o.name = a;
    else o.name += ` ${a}`;
  }
  if (o.picture !== null) {
    if (o.picture === true || !o.world || !o.directory || !o.as) throw fail('usage', USAGE);
    return o;
  }
  if (!o.name) throw fail('usage', USAGE);
  o.out ??= `shot-${o.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)}.png`;
  if (!['.png', '.jpg', '.jpeg'].includes(extname(o.out).toLowerCase())) throw fail('usage', 'a shot is written as .png or .jpg');
  return o;
}

/** The page's address for an anonymous shot: any sign-in parameter removed, `shot` added (the page hides its status). */
export function anonymous(page) {
  let u;
  try { u = new URL(page); } catch { throw fail('page-not-a-url', 'give the world page as --page <url>'); }
  for (const p of SIGN_IN_PARAMS) u.searchParams.delete(p);
  u.searchParams.set('shot', '1');
  u.username = u.password = '';
  return u.href;
}

/** The world page to shoot: `--page`, else `SOULS_PAGE`, else the `page` (or `url`) of the home's only world. */
export function pageOf(o, home, env = {}) {
  if (o.page) return o.page;
  if (env.SOULS_PAGE) return env.SOULS_PAGE;
  let worlds = {};
  try { worlds = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).worlds ?? {}; } catch { /* no config */ }
  const all = Object.values(worlds).map((w) => w.page ?? w.url).filter(Boolean);
  if (all.length === 1) return all[0];
  throw fail('which-page', all.length ? `this home has ${all.length} worlds: give one as --page <url>` : 'give the world page as --page <url>');
}

/** Playwright from the first of these folders that has it, else the global npm folder; null when none. */
export function findPlaywright(roots) {
  for (const root of roots.filter(Boolean)) for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    try { return createRequire(join(resolve(root), 'noop.js'))(name); } catch { /* not here */ }
  }
  return null;
}
export function globalNodeModules() {
  try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** The browser, headless, on the home's shot profile, with WebGL; cookies cleared. A refusal says why there is none. */
async function launch(pw, profile, size) {
  const tries = [{ channel: 'chromium' }, {}, { channel: 'chrome' }];
  const gpu = [['--ignore-gpu-blocklist'], ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']];
  let last = null;
  for (const t of tries) for (const args of gpu) {
    let ctx = null;
    try {
      ctx = await pw.chromium.launchPersistentContext(profile, {
        headless: true, ...t, args: [...args, '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
        viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1,
      });
      const page = ctx.pages()[0] ?? await ctx.newPage();
      if (await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))) {
        await ctx.clearCookies();
        return { ctx, page };
      }
      last = 'no WebGL';
      await ctx.close();
    } catch (e) {
      last = String(e.message).split('\n')[0];
      try { await ctx?.close(); } catch { /* gone */ }
      if (/Executable doesn't exist|Failed to launch/i.test(last) && t.channel) break;
    }
  }
  throw fail('no-browser', `${NO_BROWSER} (${/lock|in use|SingletonLock/i.test(last ?? '') ? 'the shot profile is in use by another shot' : last})`);
}

/**
 * One shot of `o.name` from the page at `page` into `out` (absolute). Answers what was shot: the spot, the camera, the
 * world time drawn and the milliseconds taken. `pw` is Playwright (found when not given).
 */
export async function shoot(o, { page: address, out, profile, roots = [], pw = findPlaywright([...roots, globalNodeModules()]) }) {
  const started = Date.now();
  return withWorld({ address, profile, size: o.size, pw }, async (page) => {
    const aimed = await page.evaluate(([n, e]) => globalThis.v2.capture.aim(n, e), [o.name, o.eyes]);
    if (!aimed) {
      const known = await page.evaluate(() => globalThis.v2.capture.where().slice(0, 12).map((s) => s.name));
      throw fail('nothing-by-that-name', `no Soul, place or thing called "${o.name}" in the page; some there: ${known.join(', ')}`);
    }
    if (o.eyes && aimed.spot.role !== 'soul') throw fail('eyes-are-a-souls', `${aimed.spot.name} is a ${aimed.spot.role}: --eyes takes a Soul`);
    // A few frames for the camera's move to draw, then the camera again (a body moves) and the picture.
    await settle(page);
    const again = await page.evaluate(([n, e]) => globalThis.v2.capture.aim(n, e), [o.name, o.eyes]);
    const at = await picture(page, out);
    return { ok: true, picture: out, spot: aimed.spot, camera: (again ?? aimed).aim, at, eyes: o.eyes, ms: Date.now() - started };
  });
}

/** A few frames and a moment, for a camera's move to draw. */
export const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))));

/** One more frame, then the page as `out` (.png, or .jpg at quality 85); answers the world time drawn. */
export async function picture(page, out) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const at = await page.evaluate(() => globalThis.v2.director.t ?? null);
  const jpeg = /\.jpe?g$/i.test(out);
  await page.screenshot({ path: out, type: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality: 85 } : {}) });
  return at;
}

/**
 * The page at `address`, anonymous, in the headless browser on `profile`, once it has drawn the world: `f(page)`'s
 * answer, the browser closed after. `shoot` and `view` (#3687) both look through it.
 */
export async function withWorld({ address, profile, size, pw }, f) {
  if (!pw) throw fail('no-browser', NO_BROWSER);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const { ctx, page } = await launch(pw, profile, size);
  try {
    await page.goto(anonymous(address), { waitUntil: 'domcontentloaded', timeout: READY_MS });
    await page.waitForFunction(() => globalThis.v2?.capture?.ready(), null, { timeout: READY_MS, polling: 100 })
      .catch(() => { throw fail('page-not-drawing', `the page drew no world within ${READY_MS / 1000} s`); });
    return await f(page);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * The words a shot gives when there is no browser: why, and R7's brief from the Soul's daemon (`look`) with what
 * `find` says of the name. `ask` is the daemon call (`(req) => answer`), or null when the home has no Soul.
 */
export async function inWords(o, why, ask) {
  const out = { ok: true, picture: null, why, name: o.name };
  if (!ask) return { ...out, words: null, note: 'no Soul in this home to describe it' };
  const [brief, found] = await Promise.all([ask({ op: 'look' }).catch(() => null), ask({ op: 'find', words: o.name, limit: 5 }).catch(() => null)]);
  return { ...out, words: { brief, found } };
}

/** `picture`: the creator sends a shot to the directory as the world's list picture (G6's check there). */
export async function setListPicture({ directory, world, as, file }, get = fetch) {
  const picture = readFileSync(file).toString('base64url');
  const r = await get(new URL('/v1/worlds/settings', directory).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer test:${as}` },
    body: JSON.stringify({ world, picture }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(body.refused ?? `http-${r.status}`, `the directory refused the picture: ${body.refused ?? r.status}`);
  return { ok: true, world, picture: typeof body.world?.picture === 'string' ? `${body.world.picture.length} characters` : null };
}

/** `souls.mjs shoot …`: a shot, its words when there is no browser, or `picture`. `ask` reaches the Soul's daemon. */
export async function runShoot(args, { home, env = {}, cwd = process.cwd(), ask = null, pw } = {}) {
  const o = parseShoot(args);
  if (o.picture) return setListPicture({ directory: o.directory, world: o.world, as: o.as, file: resolve(cwd, o.picture) });
  const page = pageOf(o, home, env);
  try {
    return await shoot(o, { page, out: resolve(cwd, o.out), profile: join(home, 'cache', 'shoot-browser'), roots: [env.SOULS_PLAYWRIGHT, cwd, home], ...(pw !== undefined ? { pw } : {}) });
  } catch (e) {
    if (e.code !== 'no-browser') throw e;
    return inWords(o, e.message, ask);
  }
}

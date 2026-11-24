// Pairing a Soul to this machine's agent (Engine v2 W2, #2705): the daemon's side of the device grant (RFC 8628).
// It keeps a secret and sends the directory only its hash, prints a link and a short code for the owner to approve
// signed in, polls every `interval` seconds (5 more on "slow_down"), and writes the token it is handed once into
// credentials.json (mode 0600), the one file the daemon (R6) reads it from. The token is never printed or logged.
// It also writes the world's `history` into config.json, from what the world advertises (R16b, #3480): its
// `views/world.json` (`--advert`, else `<directory>/w/<world>/views/world.json`, where the origin serves a placed
// world), whose `history` is relative to the world's folder. No advert, no `history`; the pairing still succeeds.
// Then it fetches the world's kind entries into `<home>/kinds/` from the gateway (#3760, `refreshEntries`), which
// the daemon does again at each sign-in, so a restarted or changed world's kinds reach the client's own checks.
//
//   node v2/client/src/pair/pair.mjs --directory <origin> --world <key> --gateway <ws url> --device <name>
//        --label <agent label> [--soul <grant> | --creator <creator grant>] [--force] [--advert <url of world.json>]
//   With --creator (G7, #2796) it asks for the world's creator scope: `creator-<scope hex>-<n>`, kept as `c_<...>`.
//   Prints one JSON line with the link and code, then one with the outcome: `{ok, soul, history}` or `{ok: false, code}`.
//   The home is SOULS_HOME, else the nearest .souls, else ./.souls.

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { writeGuide } from '../home/guide.mjs';
import { CREDENTIALS, Refused, findHome, makeHome } from '../home/home.mjs';

const SLOW_DOWN = 5;

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Refused('home-unreadable', `${file.endsWith(CREDENTIALS) ? CREDENTIALS : file} cannot be read`);
  }
}

function writePrivate(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

/** Where a world advertises itself by default: its folder under the origin's `w/` (as the page's `?world=`). */
export const advertOf = (directory, world) => new URL(`w/${encodeURIComponent(world)}/views/world.json`, `${new URL(directory).origin}/`).href;

/**
 * The history address a world advertises, as an absolute http(s) url ending in `/`, or null: `history` in its
 * `world.json`, relative to the world's folder (the advert's parent's parent).
 */
export async function advertisedHistory(advert, { within = 5000 } = {}) {
  try {
    const r = await fetch(advert, { signal: AbortSignal.timeout(within) });
    if (!r.ok) return null;
    const h = (await r.json())?.history;
    if (typeof h !== 'string') return null;
    const u = new URL(h.replace(/\/?$/, '/'), new URL('../', advert));
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** The gateway's entries address from its socket address: `ws(s)://…/v2/ws` is `http(s)://…/v2/entries`. */
export function entriesOf(gateway) {
  const u = new URL(gateway);
  u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
  u.pathname = u.pathname.replace(/\/v2\/ws$/, '') + '/v2/entries';
  u.search = ''; u.hash = '';
  return u.href;
}

/**
 * The world's kind entries (#3760): fetched from the gateway's `GET /v2/entries` with the Soul's token, sent with the
 * tag of the last copy kept (`<home>/kinds/.entries-<world>.json`), so an unchanged world sends nothing. Each entry is
 * written as `<home>/kinds/<kind, : as .>.json`, where the checks read them (`check/state.mjs` `kindsIn`), and an
 * entry this world sent before and no longer does is removed. Resolves to `{entries, changed}`; rejects on a refusal.
 */
export async function refreshEntries({ home, world, gateway, token, within = 10000 }) {
  const dir = join(home, 'kinds'), mark = join(dir, `.entries-${encodeURIComponent(world)}.json`);
  let held = {};
  try { held = JSON.parse(readFileSync(mark, 'utf8')); } catch { /* none kept yet */ }
  if (!(held.files ?? []).every((f) => existsSync(join(dir, f)))) held = { files: held.files }; // a file gone: fetch all
  const r = await fetch(entriesOf(gateway), {
    headers: { authorization: `Bearer ${token}`, ...(held.etag ? { 'if-none-match': held.etag } : {}) },
    signal: AbortSignal.timeout(within),
  });
  if (r.status === 304) return { entries: held.files?.length ?? 0, changed: false };
  if (!r.ok) {
    let code = `entries-${r.status}`;
    try { code = (await r.json()).refused ?? code; } catch { /* not JSON */ }
    throw new Refused(code, `the gateway answered ${r.status} for the world's entries`);
  }
  const list = await r.json();
  if (!Array.isArray(list)) throw new Refused('entries-answer', 'the entries are not a list');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const e of list) {
    if (e?.format !== 'souls-entry/1' || typeof e.kind !== 'string' || !/^[\w.:@-]+$/.test(e.kind)) continue;
    const f = `${e.kind.replaceAll(':', '.')}.json`;
    writeFileSync(join(dir, `${f}.tmp`), JSON.stringify(e));
    renameSync(join(dir, `${f}.tmp`), join(dir, f));
    files.push(f);
  }
  const now = new Set(files);
  for (const f of held.files ?? []) if (!now.has(f) && /^[\w.@-]+\.json$/.test(f)) rmSync(join(dir, f), { force: true });
  writeFileSync(`${mark}.tmp`, JSON.stringify({ etag: r.headers.get('etag'), files }) + '\n');
  renameSync(`${mark}.tmp`, mark);
  return { entries: files.length, changed: true };
}

/**
 * The local id the daemon knows a Soul by, from its grant: `soul-<scope>-<n>` is `s_<scope>-<n>`; a world's creator,
 * `creator-<scope>-<n>`, is `c_<scope>-<n>` (G7, #2796).
 */
export const localId = (grant) => grant.startsWith('creator-') ? `c_${grant.slice('creator-'.length)}` : `s_${grant.slice('soul-'.length)}`;

/**
 * Asks, waits for the owner's approval, and keeps the token. `onAsk({link, code})` is called once the directory has
 * given the code; `unit` is the milliseconds in a second of polling interval (tests shorten it). Resolves to
 * `{soul, grant}`; rejects with a `Refused` naming why (and the device, for `soul-connected`).
 */
export async function pair({ home, directory, world, gateway, device, label, soul, creator, force = false, onAsk, unit = 1000, sleep, onPoll, advert }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // The token comes back in the poll's answer: over https, or plain http to this machine only.
  const at = new URL(directory);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(at.hostname) || at.hostname.endsWith('.localhost');
  if (at.protocol !== 'https:' && !(at.protocol === 'http:' && loopback)) throw new Refused('directory-not-https', 'the directory must be https, or http on this machine');
  const post = async (path, body) => {
    const r = await fetch(new URL(path, directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  const secret = randomBytes(32).toString('hex');
  const asked = await post('/v1/pair/request', {
    secret_hash: createHash('sha256').update(secret).digest('hex'),
    // A creator (G7) names the world's creator grant its account holds; the directory never makes one. A Soul's
    // request names the world it is paired for (W11).
    device, label, force, ...(creator ? { scope: 'creator', soul: creator } : { scope: 'soul', world, ...(soul ? { soul } : { new: true }) }),
  });
  if (asked.refused) throw new Refused(asked.refused, 'the directory refused the request');
  onAsk?.({ link: asked.link, code: asked.code });
  let interval = asked.interval ?? 5;
  for (;;) {
    await wait(interval * unit);
    const got = await post('/v1/pair/poll', { secret });
    onPoll?.({ interval, pending: got.pending });
    if (got.pending === 'slow_down') { interval = Math.max(got.interval ?? 0, interval + SLOW_DOWN); continue; }
    if (got.pending) continue;
    if (got.refused) throw Object.assign(new Refused(got.refused, got.device ? `connected to ${got.device}` : 'refused'), { device: got.device ?? null });
    if (typeof got.token !== 'string' || typeof got.grant !== 'string') throw new Refused('pair-answer', 'no token in the answer');
    makeHome(home); // a new home gets its .gitignore (0.133 Q2)
    const id = localId(got.grant);
    const history = await advertisedHistory(advert ?? advertOf(directory, world));
    const configFile = join(home, 'config.json');
    const config = readJson(configFile);
    config.worlds = { ...config.worlds, [world]: { ...config.worlds?.[world], url: directory, gateway, ...(history ? { history } : {}) } };
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const credFile = join(home, CREDENTIALS);
    const creds = existsSync(credFile) ? readJson(credFile) : {};
    creds.souls = { ...creds.souls, [id]: { ...creds.souls?.[id], [world]: { token: got.token } } };
    writePrivate(credFile, creds);
    // R19: the folder's guide names who lives here now. The Soul is paired whether or not the guide could be written.
    // #3760: the world's kinds, so the client's own checks know them; the Soul is paired whether or not they came.
    let entries;
    try { entries = (await refreshEntries({ home, world, gateway, token: got.token })).entries; } catch (e) { entries = { failed: e.code ?? 'entries-unreachable' }; }
    let guide;
    try { guide = writeGuide(home); } catch (e) { guide = { failed: String(e.message ?? e).slice(0, 120) }; }
    // #3702: the world's welcome, shown to the Soul as it arrives.
    return { soul: id, grant: got.grant, history, entries, guide, ...(typeof got.welcome === 'string' ? { welcome: got.welcome } : {}) };
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  const say = (v) => console.log(JSON.stringify(v));
  try {
    for (const n of ['--directory', '--world', '--gateway']) if (!opt(n)) throw new Refused('usage', `${n} is needed`);
    // 0.133 Q2: a pairing never lands in a parent folder's home, unless `--home` names it
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir(), adds: true, named: opt('--home') ?? null });
    const out = await pair({
      home, directory: opt('--directory'), world: opt('--world'), gateway: opt('--gateway'),
      device: opt('--device') ?? hostname().slice(0, 64), label: opt('--label') ?? 'agent',
      soul: opt('--soul'), creator: opt('--creator'), force: args.includes('--force'), advert: opt('--advert'),
      onAsk: ({ link, code }) => say({ ok: true, step: 'approve', link, code, say: 'Open the link signed in, check the code matches, and approve.' }),
    });
    say({ ok: true, ...out });
  } catch (e) {
    say({ ok: false, code: e.code ?? 'failed', ...(e.device ? { device: e.device } : {}), detail: String(e.message ?? e).slice(0, 200) });
    process.exitCode = 1;
  }
}

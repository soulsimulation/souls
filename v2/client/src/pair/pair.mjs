// Pairing a Soul to this machine's agent (Engine v2 W2, #2705): the daemon's side of the device grant (RFC 8628).
// It keeps a secret and sends the directory only its hash, prints a link and a short code for the owner to approve
// signed in, polls every `interval` seconds (5 more on "slow_down"), and writes the token it is handed once into
// credentials.json (mode 0600), the one file the daemon (R6) reads it from. The token is never printed or logged.
// It also writes the world's `history` into config.json, from what the world advertises (R16b, #3480): its
// `views/world.json` (`--advert`, else `<directory>/w/<world>/views/world.json`, where the origin serves a placed
// world), whose `history` is relative to the world's folder. No advert, no `history`; the pairing still succeeds.
//
//   node v2/client/src/pair/pair.mjs --directory <origin> --world <key> --gateway <ws url> --device <name>
//        --label <agent label> [--soul <grant> [--force]] [--advert <url of world.json>]
//   Prints one JSON line with the link and code, then one with the outcome: `{ok, soul, history}` or
//   `{ok: false, code}`.
//   The home is SOULS_HOME, else the nearest .souls, else ./.souls.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIALS, Refused, findHome } from '../home/home.mjs';

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

/** The local id the daemon knows a Soul by, from its grant: `soul-<scope>-<n>` is `s_<scope>-<n>`. */
export const localId = (grant) => `s_${grant.slice('soul-'.length)}`;

/**
 * Asks, waits for the owner's approval, and keeps the token. `onAsk({link, code})` is called once the directory has
 * given the code; `unit` is the milliseconds in a second of polling interval (tests shorten it). Resolves to
 * `{soul, grant}`; rejects with a `Refused` naming why (and the device, for `soul-connected`).
 */
export async function pair({ home, directory, world, gateway, device, label, soul, force = false, onAsk, unit = 1000, sleep, onPoll, advert }) {
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
    device, label, scope: 'soul', force, ...(soul ? { soul } : { new: true }),
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
    mkdirSync(home, { recursive: true, mode: 0o700 });
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
    return { soul: id, grant: got.grant, history };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  const say = (v) => console.log(JSON.stringify(v));
  try {
    for (const n of ['--directory', '--world', '--gateway']) if (!opt(n)) throw new Refused('usage', `${n} is needed`);
    const home = findHome({ cwd: process.cwd(), env: process.env, homedir: homedir() });
    const out = await pair({
      home, directory: opt('--directory'), world: opt('--world'), gateway: opt('--gateway'),
      device: opt('--device') ?? hostname().slice(0, 64), label: opt('--label') ?? 'agent',
      soul: opt('--soul'), force: args.includes('--force'), advert: opt('--advert'),
      onAsk: ({ link, code }) => say({ ok: true, step: 'approve', link, code, say: 'Open the link signed in, check the code matches, and approve.' }),
    });
    say({ ok: true, ...out });
  } catch (e) {
    say({ ok: false, code: e.code ?? 'failed', ...(e.device ? { device: e.device } : {}), detail: String(e.message ?? e).slice(0, 200) });
    process.exitCode = 1;
  }
}

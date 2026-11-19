// Pairing a Soul to this machine's agent (Engine v2 W2, #2705): the daemon's side of the device grant (RFC 8628).
// It keeps a secret and sends the directory only its hash, prints a link and a short code for the owner to approve
// signed in, polls every `interval` seconds (5 more on "slow_down"), and writes the token it is handed once into
// credentials.json (mode 0600), the one file the daemon (R6) reads it from. The token is never printed or logged.
//
//   node v2/client/src/pair/pair.mjs --directory <origin> --world <key> --gateway <ws url> --device <name>
//        --label <agent label> [--soul <grant> | --creator <creator grant>] [--force]
//   With --creator (G7, #2796) it asks for the world's creator scope: `creator-<scope hex>-<n>`, kept as `c_<...>`.
//   Prints one JSON line with the link and code, then one with the outcome: `{ok, soul}` or `{ok: false, code}`.
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
export async function pair({ home, directory, world, gateway, device, label, soul, creator, force = false, onAsk, unit = 1000, sleep, onPoll }) {
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
    // A creator (G7) names the world's creator grant its account holds; the directory never makes one.
    device, label, force, ...(creator ? { scope: 'creator', soul: creator } : { scope: 'soul', ...(soul ? { soul } : { new: true }) }),
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
    const configFile = join(home, 'config.json');
    const config = readJson(configFile);
    config.worlds = { ...config.worlds, [world]: { ...config.worlds?.[world], url: directory, gateway } };
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    const credFile = join(home, CREDENTIALS);
    const creds = existsSync(credFile) ? readJson(credFile) : {};
    creds.souls = { ...creds.souls, [id]: { ...creds.souls?.[id], [world]: { token: got.token } } };
    writePrivate(credFile, creds);
    return { soul: id, grant: got.grant };
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
      soul: opt('--soul'), creator: opt('--creator'), force: args.includes('--force'),
      onAsk: ({ link, code }) => say({ ok: true, step: 'approve', link, code, say: 'Open the link signed in, check the code matches, and approve.' }),
    });
    say({ ok: true, ...out });
  } catch (e) {
    say({ ok: false, code: e.code ?? 'failed', ...(e.device ? { device: e.device } : {}), detail: String(e.message ?? e).slice(0, 200) });
    process.exitCode = 1;
  }
}

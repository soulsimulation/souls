// The home on the owner's machine (Engine v2 R6, #2700), ported from tools/world-launcher/soul/home.mjs as far as
// the resident daemon needs it. The layout is unchanged:
//
//   .souls/config.json        worlds by key: `{ worlds: { <key>: { url, gateway, history } } }`; `gateway` is a v2 world's
//                             agents' socket (`ws://<host>/v2/ws`, I1), `history` where its public history is served
//                             (V9's `h/<world>/<lineage>/`, for R16's `history`)
//   .souls/credentials.json   mode 0600, the only file that holds a token: `{ souls: { <id>: { <key>: { token } } } }`
//   .souls/souls/<id>/runtime/ the daemon's lock, its log, its state (cursor, sequences) and its socket
//
// A token is read here and handed to the daemon in memory. It never goes into an argument, an environment variable,
// a log line, an error or any file but credentials.json.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const HOME_NAME = '.souls';
export const CREDENTIALS = 'credentials.json';
// A Soul's local id is `s_<scope hex>-<n>`; a world creator's (G7, #2796) is `c_<scope hex>-<n>`.
const SOUL_ID = /^[sc]_[A-Za-z0-9_-]+$/;
// A Unix socket's path is at most 104 bytes on macOS and 108 on Linux, its terminator included.
const SOCKET_MOST = 100;
const SOCKET = 'daemon.sock';

/** A refusal, by name. Its message never holds a token. */
export class Refused extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isHome = (root) => existsSync(join(root, 'config.json')) || existsSync(join(root, 'souls'));

/** The home: `SOULS_HOME`, else the nearest `.souls` from `cwd` up to `homedir` (home.mjs `findHome`). */
export function findHome({ cwd, env = {}, homedir }) {
  if (env.SOULS_HOME) return resolve(cwd, env.SOULS_HOME);
  const start = real(cwd), stop = homedir ? real(homedir) : null;
  for (let dir = start; ; dir = dirname(dir)) {
    if (isHome(join(dir, HOME_NAME))) return join(dir, HOME_NAME);
    if (dir === stop || dirname(dir) === dir) return join(start, HOME_NAME);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    // A parser quotes what it choked on, so credentials.json's bytes never reach a message.
    throw new Refused('home-unreadable', `${file.endsWith(CREDENTIALS) ? CREDENTIALS : file} cannot be read`);
  }
}

/** A Soul's runtime folder, made with mode 0700, and where its files are. */
export function runtimeOf(root, soul) {
  if (!SOUL_ID.test(soul ?? '')) throw new Refused('not-a-soul-id', String(soul).slice(0, 40));
  const dir = resolve(root, 'souls', soul, 'runtime');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    lock: join(dir, 'daemon.lock'),
    log: join(dir, 'daemon.log'),
    state: join(dir, 'daemon.json'),
    socket: join(dir, SOCKET),
  };
}

/**
 * Runs `f(path)` with a path to the socket at `socket` that a Unix socket call accepts. A path beyond about 100
 * bytes fails, so a long one is reached from its folder by its bare name: `f` must use the path at once (`listen`
 * and `connect` take it synchronously). Nothing goes to a shared folder such as /tmp, which a sandbox may forbid.
 */
export function atSocket(socket, f) {
  if (Buffer.byteLength(socket) <= SOCKET_MOST) return f(socket);
  const was = process.cwd();
  process.chdir(dirname(socket));
  try {
    return f(`./${basename(socket)}`);
  } finally {
    process.chdir(was);
  }
}

/** The Souls with a token in this home. */
export function soulsWithTokens(root) {
  return Object.entries(readJson(join(root, CREDENTIALS)).souls ?? {})
    .filter(([, worlds]) => Object.values(worlds ?? {}).some((w) => typeof w?.token === 'string'))
    .map(([id]) => id);
}

/** The worlds (this home's keys) where Soul `soul` holds a token. The tokens themselves are not returned. */
export function worldsOf(root, soul) {
  const worlds = readJson(join(root, CREDENTIALS)).souls?.[soul] ?? {};
  return Object.keys(worlds).filter((k) => typeof worlds[k]?.token === 'string');
}

/** The folder a person sees: the one holding `.souls/`, or a SOULS_HOME itself. */
export const folderOf = (root) => (basename(root) === HOME_NAME ? dirname(root) : root);

/**
 * What the daemon connects with: the world's gateway, the Soul's grant (its actor, the token's part before the
 * secret: `soul-<scope hex>-<counter>`, or a world creator's, `creator-<scope hex>-<counter>`, G7 #2796) and the
 * token. credentials.json must be mode 0600.
 */
export function readSeat(root, soul) {
  const file = join(root, CREDENTIALS);
  if (!existsSync(file)) throw new Refused('no-credentials', `no ${CREDENTIALS} in this home`);
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Refused('credentials-too-open', `${CREDENTIALS} is ${mode.toString(8)}, not 600`);
  const worlds = readJson(file).souls?.[soul] ?? {};
  const key = Object.keys(worlds).find((k) => typeof worlds[k]?.token === 'string');
  if (!key) throw new Refused('no-token', `no token for ${soul}`);
  const { gateway, history } = readJson(join(root, 'config.json')).worlds?.[key] ?? {};
  if (typeof gateway !== 'string') throw new Refused('no-gateway', `world ${key} has no gateway`);
  const token = worlds[key].token;
  const m = /^(soul|creator)-([0-9a-f]{32})-(\d+)\.[0-9a-f]{64}$/.exec(token);
  if (!m) throw new Refused('token-not-a-soul-token', `the token for ${soul} is not a Soul's or a creator's v2 token`);
  return { world: key, gateway, grant: { actor: m[1], scope: m[2], counter: BigInt(m[3]) }, token, ...(typeof history === 'string' ? { history } : {}) };
}

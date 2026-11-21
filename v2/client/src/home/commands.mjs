// R17b (#3561): the six commands over the owner's v2 home. Tokens stay in credentials.json; moving a Soul keeps
// its memory and daemon cursor/sequence bytes, and removes the source only after the destination verifies.
// Through the served eden.mjs: list; default <id|name>; export <id|name> --out <new folder>; import <folder>;
// adopt <id|grant> [world URL] [--force]; doctor. Adoption prints W2's owner approval link before waiting.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { CREDENTIALS, Refused, runtimeOf, soulsWithTokens } from './home.mjs';
import { request } from '../daemon/client.mjs';
import { localId, pair } from '../pair/pair.mjs';
import { pairAddress } from '../pair/address.mjs';
import { accountCommand, accountList, accountPair, connectedAccounts, hasAccount } from '../account/account.mjs';
import { feedSites, newsCommand, unread } from './news.mjs';

export const HOME_COMMANDS = ['list', 'default', 'export', 'import', 'adopt', 'doctor', 'login', 'accounts', 'logout', 'dashboard', 'news'];
const ID = /^s_[A-Za-z0-9_-]+$/;
const GRANT = /^soul-[0-9a-f]{32}-\d+$/;
const VOLATILE = new Set(['runtime/daemon.lock', 'runtime/daemon.sock', 'runtime/daemon.log']);
const read = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Refused('home-unreadable', `${file.endsWith(CREDENTIALS) ? CREDENTIALS : 'home metadata'} cannot be read`);
  }
};
function put(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
const configOf = (home) => read(join(home, 'config.json'));
const credsOf = (home) => ({ souls: {}, ...read(join(home, CREDENTIALS)) });
const aliasesOf = (home) => read(join(home, 'aliases.json')).ids ?? {};
const canonical = (id, aliases) => aliases[id] ?? id;
const soulDir = (home, id) => join(home, 'souls', id);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Resident ids come from tokens or actual Soul folders; old config ids only supply their carried names. */
export function listSouls(home) {
  const config = configOf(home), aliases = aliasesOf(home), creds = credsOf(home);
  const dirs = existsSync(join(home, 'souls')) ? readdirSync(join(home, 'souls'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  return [...new Set([...soulsWithTokens(home), ...dirs])].filter((id) => ID.test(id)).map((id) => {
    const former = Object.keys(config.souls ?? {}).find((old) => canonical(old, aliases) === id);
    const meta = config.souls?.[former] ?? {};
    const world = Object.keys(creds.souls[id] ?? {}).find((k) => typeof creds.souls[id][k]?.token === 'string') ?? meta.world ?? null;
    return { id, world, name: typeof meta.name === 'string' ? meta.name : null, default: canonical(config.default, aliases) === id };
  });
}

/** An explicit id/name, then the home's default, then its sole eligible Soul. Ambiguity is always a refusal. */
export function chooseSoul(home, named, eligible) {
  const aliases = aliasesOf(home), rows = listSouls(home).filter((s) => !eligible || eligible.includes(s.id));
  const selected = named ?? configOf(home).default;
  if (selected) {
    const id = canonical(selected, aliases);
    const matches = rows.filter((s) => s.id === id || s.name?.toLowerCase() === String(selected).toLowerCase());
    if (matches.length === 1) return matches[0].id;
    if (!matches.length) throw new Refused('no-such-soul', 'choose a Soul from list');
  } else if (rows.length === 1) return rows[0].id;
  throw new Refused('which-soul', `name a Soul with --soul: ${rows.map((s) => `${s.name ?? s.id} (${s.id})`).join(', ') || 'none lives here'}`);
}

/** A command can use a token-backed Soul or an answering resident daemon whose token has been removed. */
export async function chooseCommandSoul(home, named) {
  const tokens = new Set(soulsWithTokens(home));
  const eligible = await Promise.all(listSouls(home).map(async ({ id }) => {
    if (tokens.has(id)) return id;
    try {
      const status = await request(runtimeOf(home, id).socket, { op: 'status' });
      return status.ok && status.soul === id ? id : null;
    } catch { return null; }
  }));
  const soul = chooseSoul(home, named, eligible.filter(Boolean));
  // Direct reuse prevents a disappearing tokenless daemon from starting a replacement without credentials.
  return { soul, resident: !tokens.has(soul) };
}

function setDefault(home, named) {
  if (!named) throw new Refused('usage', 'default <Soul id or name>');
  const soul = chooseSoul(home, named), config = configOf(home);
  config.default = soul;
  put(join(home, 'config.json'), config);
  return { ok: true, default: listSouls(home).find((s) => s.id === soul) };
}

/** Stop an existing daemon without starting one just to stop it; wait for its final save and lock release. */
async function stopForMove(home, soul) {
  const rt = runtimeOf(home, soul), lock = () => read(rt.lock);
  if (existsSync(rt.socket)) {
    try { await request(rt.socket, { op: 'stop' }); } catch (e) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw new Refused('daemon-not-stopped', 'the Soul has not stopped');
    }
  }
  for (const until = Date.now() + 5000; alive(lock().pid);) {
    if (Date.now() >= until) throw new Refused('daemon-not-stopped', 'the Soul has not stopped');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The whole move is exclusive before its first await. This lock is never reclaimed by another mover: an
// interrupted move needs inspection rather than risking a second copy of its private token.
function guardMove(folder) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lock = join(folder, '.move.lock');
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Refused('home-busy', 'another move holds this folder; an interrupted move needs inspection');
  }
  return () => { if (read(lock).pid === process.pid) rmSync(lock, { force: true }); };
}

// Keep another command from starting the daemon between its stop and the completed move.
function holdMove(home, soul) {
  const rt = runtimeOf(home, soul);
  if (alive(read(rt.lock).pid)) throw new Refused('daemon-not-stopped', 'a daemon started before the move');
  // Never unlink a stale observation: a daemon may have acquired that path since we read it.
  try { writeFileSync(rt.lock, JSON.stringify({ pid: process.pid, soul }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Refused('home-busy', 'the Soul is already being started or moved'); }
  return () => { if (read(rt.lock).pid === process.pid) rmSync(rt.lock, { force: true }); };
}

/** Only regular durable files are movable: never follow a symlink or copy a running socket. */
function filesIn(dir, prefix = '') {
  const out = new Map();
  if (!existsSync(dir)) return out;
  if (!lstatSync(dir).isDirectory()) throw new Refused('unsupported-home-file', 'a Soul folder must be a directory');
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (VOLATILE.has(rel)) continue;
    if (e.isDirectory()) for (const [name, bytes] of filesIn(join(dir, e.name), rel)) out.set(name, bytes);
    else if (e.isFile()) out.set(rel, readFileSync(join(dir, e.name)));
    else throw new Refused('unsupported-home-file', 'only regular durable Soul files can move');
  }
  return out;
}
function copyFiles(files, to) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const [rel, bytes] of files) {
    const file = join(to, rel);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  }
}
function verifyFiles(files, dir) {
  const got = filesIn(dir);
  if (files.size !== got.size || [...files].some(([name, bytes]) => !got.get(name)?.equals(bytes))) throw new Refused('copy-not-verified', 'the source is kept; the copied bytes differ');
}
function verifyCredentials(dir, expected) {
  if ((statSync(join(dir, CREDENTIALS)).mode & 0o777) !== 0o600 || !equal(credsOf(dir), expected)) throw new Refused('copy-not-verified', 'the source is kept; private credentials did not verify');
}
const contains = (parent, child) => { const rel = relative(parent, child); return !rel || (!rel.startsWith('..') && !rel.startsWith('/')); };
function separate(home, other) {
  if (contains(resolve(home), other) || contains(other, resolve(home))) throw new Refused('move-overlap', 'the transit folder and home must be separate');
}

export async function exportSoul(home, named, out) {
  if (!out) throw new Refused('usage', 'export <Soul id or name> --out <folder>');
  const soul = chooseSoul(home, named), to = resolve(out);
  separate(home, to);
  if (existsSync(to)) throw new Refused('destination-exists', 'choose a new transit folder');
  const releaseMove = guardMove(home);
  try {
    await stopForMove(home, soul);
    const release = holdMove(home, soul);
    try {
      const creds = credsOf(home), entry = creds.souls[soul], config = configOf(home);
      const row = listSouls(home).find((s) => s.id === soul), world = row.world;
      if (!entry || !Object.values(entry).some((e) => typeof e?.token === 'string')) throw new Refused('no-token', 'this Soul has no token to move');
      if ((statSync(join(home, CREDENTIALS)).mode & 0o777) !== 0o600) throw new Refused('credentials-too-open', 'run doctor before moving this Soul');
      const { url, gateway, history } = config.worlds?.[world] ?? {};
      if (typeof url !== 'string' || typeof gateway !== 'string') throw new Refused('no-gateway', 'the Soul has no configured world');
      const files = filesIn(soulDir(home, soul));
      mkdirSync(to, { recursive: true, mode: 0o700 });
      copyFiles(files, soulDir(to, soul));
      const transit = { souls: { [soul]: entry } };
      put(join(to, CREDENTIALS), transit);
      const meta = { id: soul, world, url, gateway, ...(typeof history === 'string' ? { history } : {}), name: row.name };
      put(join(to, 'soul.json'), meta);
      verifyFiles(files, soulDir(to, soul));
      verifyFiles(files, soulDir(home, soul));
      verifyCredentials(to, transit);
      if (!equal(read(join(to, 'soul.json')), meta)) throw new Refused('copy-not-verified', 'the source is kept; metadata differs');
      const current = credsOf(home);
      if (!equal(current.souls[soul], entry)) throw new Refused('source-changed', 'the source is kept; credentials changed during the move');
      delete current.souls[soul];
      put(join(home, CREDENTIALS), current);
      const latest = configOf(home), aliases = aliasesOf(home);
      if (canonical(latest.default, aliases) === soul) delete latest.default;
      for (const id of Object.keys(latest.souls ?? {})) if (canonical(id, aliases) === soul) delete latest.souls[id];
      put(join(home, 'config.json'), latest);
      rmSync(soulDir(home, soul), { recursive: true, force: true });
      return { ok: true, exported: true, soul };
    } finally { release(); }
  } finally { releaseMove(); }
}

export function importSoul(home, folder) {
  if (!folder) throw new Refused('usage', 'import <transit folder>');
  const from = resolve(folder);
  separate(home, from);
  if (!existsSync(from) || !lstatSync(from).isDirectory()) throw new Refused('not-a-soul-export', 'name an existing transit folder');
  const releaseSource = guardMove(from);
  try {
    const meta = read(join(from, 'soul.json')), soul = meta.id;
    if (!ID.test(soul ?? '') || typeof meta.world !== 'string' || typeof meta.url !== 'string' || typeof meta.gateway !== 'string') throw new Refused('not-a-soul-export', 'the transit metadata is incomplete');
    const transit = credsOf(from), entry = transit.souls[soul];
    if (!entry || Object.keys(transit.souls).length !== 1 || typeof entry[meta.world]?.token !== 'string') throw new Refused('not-a-soul-export', 'the transit folder must hold exactly this Soul');
    verifyCredentials(from, { souls: { [soul]: entry } });
    const releaseHome = guardMove(home);
    try {
      const creds = credsOf(home), config = configOf(home);
      if (creds.souls[soul] || existsSync(soulDir(home, soul))) throw new Refused('already-here', 'the Soul already lives here');
      const world = { url: meta.url, gateway: meta.gateway, ...(typeof meta.history === 'string' ? { history: meta.history } : {}) };
      const old = config.worlds?.[meta.world];
      if (old && (old.url !== world.url || old.gateway !== world.gateway)) throw new Refused('world-conflict', 'this world key already names another address; the transit folder is kept');
      const files = filesIn(soulDir(from, soul));
      copyFiles(files, soulDir(home, soul));
      const release = holdMove(home, soul);
      try {
        config.worlds = { ...config.worlds, [meta.world]: { ...old, ...world } };
        config.souls = { ...config.souls, [soul]: { name: typeof meta.name === 'string' ? meta.name : null, world: meta.world } };
        put(join(home, 'config.json'), config);
        creds.souls[soul] = entry;
        put(join(home, CREDENTIALS), creds);
        verifyFiles(files, soulDir(home, soul));
        verifyFiles(files, soulDir(from, soul));
        verifyCredentials(home, creds);
        verifyCredentials(from, transit);
        if (!equal(read(join(from, 'soul.json')), meta)) throw new Refused('source-changed', 'the transit folder is kept; metadata changed during the move');
        rmSync(from, { recursive: true });
        return { ok: true, imported: true, soul };
      } finally { release(); }
    } finally { releaseHome(); }
  } finally { releaseSource(); }
}

export async function adoptSoul(home, named, url, { force = false, onAsk, as, move = false } = {}) {
  if (as || hasAccount(home)) return accountPair(home, named, url, { as, move: move || force });
  const grant = named?.startsWith('s_') ? `soul-${named.slice(2)}` : named;
  if (!GRANT.test(grant ?? '')) throw new Refused('adopt-names-a-soul', 'adopt <Soul id or grant> [world url]');
  if (soulsWithTokens(home).includes(localId(grant))) throw new Refused('already-here', 'the Soul is already paired in this home');
  const config = configOf(home);
  if (!url) {
    const worlds = Object.values(config.worlds ?? {});
    if (worlds.length !== 1) throw new Refused('which-world', 'adopt needs a world URL when the home has several worlds or none');
    url = worlds[0].url;
  }
  const spec = await pairAddress(url), world = spec.world;
  if (config.worlds?.[world]?.url && new URL(config.worlds[world].url).origin !== spec.directory) throw new Refused('world-conflict', 'this world key already names another directory');
  force ||= move;
  return { ok: true, paired: true, ...(await pair({ home, world, ...spec, device: 'agent', label: 'souls adopt', soul: grant, force, onAsk })) };
}

export async function doctor(home) {
  const credentials = join(home, CREDENTIALS);
  if (existsSync(credentials)) chmodSync(credentials, 0o600);
  const rows = listSouls(home), creds = credsOf(home), config = configOf(home), locksCleared = [];
  for (const { id } of rows) {
    const rt = runtimeOf(home, id);
    if (existsSync(rt.lock) && !alive(read(rt.lock).pid)) {
      rmSync(rt.lock, { force: true });
      rmSync(rt.socket, { force: true });
      locksCleared.push({ soul: id, lock: 'daemon.lock' });
    }
  }
  const noToken = rows.filter((r) => !soulsWithTokens(home).includes(r.id)).map(({ id }) => id);
  const orphanCredentials = Object.entries(creds.souls).flatMap(([id, worlds]) => Object.keys(worlds ?? {}).filter((world) => !ID.test(id) || !config.worlds?.[world]).map((world) => ({ principal: id, world })));
  const worlds = await Promise.all(Object.entries(config.worlds ?? {}).map(async ([world, spec]) => {
    try {
      const at = new URL(spec.gateway ?? spec.url);
      if (at.protocol === 'ws:') at.protocol = 'http:';
      if (at.protocol === 'wss:') at.protocol = 'https:';
      const r = await fetch(at, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      await r.body?.cancel();
      return { world, checked: r.status >= 500 ? 'unreachable' : 'reachable' };
    } catch { return { world, checked: 'unreachable' }; }
  }));
  const unreachable = worlds.filter((w) => w.checked === 'unreachable').map((w) => w.world);
  return { ok: true, healthy: !noToken.length && !orphanCredentials.length && !unreachable.length, locksCleared, noToken, orphanCredentials, worlds, unreachable };
}

/**
 * #3708: `dashboard`, the home at a glance, read on this machine only (today's dashboard asks no world): each Soul's
 * world and state (paired, its daemon up and connected, retired), its memory, the account connections and unread news.
 * A daemon that is down is not started.
 */
export async function dashboard(home) {
  const config = configOf(home), creds = credsOf(home);
  const souls = await Promise.all(listSouls(home).map(async (s) => {
    const meta = config.souls?.[s.id] ?? {}, paired = Object.values(creds.souls[s.id] ?? {}).some((w) => typeof w?.token === 'string');
    let daemon = { up: false };
    try {
      const st = await request(runtimeOf(home, s.id).socket, { op: 'status' }, 1500);
      if (st?.ok && st.soul === s.id) daemon = { up: true, connected: !!st.connected, cursor: st.cursor ?? null, unanswered: st.unanswered?.length ?? 0, now: st.now ?? null, upMs: st.upMs ?? null };
    } catch { /* not running */ }
    const state = meta.retiredAt ? 'retired' : !paired ? 'unpaired' : daemon.up && daemon.connected ? 'connected' : 'paired';
    return { ...s, state, ...(meta.retiredAt ? { retiredAt: meta.retiredAt } : {}), daemon, memory: existsSync(join(home, 'souls', s.id, 'memory')) };
  }));
  let accounts = []; try { accounts = connectedAccounts(home).accounts; } catch { /* none readable */ }
  const worlds = Object.entries(config.worlds ?? {}).map(([key, w]) => ({ world: key, url: w?.url ?? null, souls: souls.filter((s) => s.world === key).length }));
  return { ok: true, souls, worlds, accounts, news: { sites: feedSites(config).length, unread: unread(config), then: 'news' },
    note: 'Read on this machine only: it asks no world, starts no daemon and runs no model.' };
}

export async function homeCommand(home, command, args = [], options = {}) {
  const asAt = args.indexOf('--as'), as = asAt < 0 ? undefined : args[asAt + 1];
  if (['login', 'accounts', 'logout'].includes(command)) return accountCommand(home, command, args);
  if (command === 'list') return args.includes('--account') ? accountList(home, as) : { ok: true, souls: listSouls(home) };
  if (command === 'dashboard') return dashboard(home);
  if (command === 'news') return newsCommand(home, args);
  if (command === 'default') return setDefault(home, args[0]);
  if (command === 'doctor') return doctor(home);
  if (command === 'import') return importSoul(home, args[0]);
  if (command === 'export') {
    const k = args.indexOf('--out');
    return exportSoul(home, args[0], k < 0 ? undefined : args[k + 1]);
  }
  if (command === 'adopt') return adoptSoul(home, args[0], args.slice(1).find((a) => /^https?:\/\//.test(a)), { ...options, as, move: args.includes('--move'), force: args.includes('--force') });
  throw new Refused('unknown-command', 'choose a home command');
}

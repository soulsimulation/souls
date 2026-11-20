// A home on today's client comes across with its Souls and their memory (Engine v2 R18, #2821).
//
// Today's client installs this one by its own `upgrade` (the frozen path, docs/architecture/api.md): the bundle replaced
// stays in `bin/eden-<version>.mjs`, `config.client` and `config.previousClient` say which is which. The home is kept as
// it is. This client's `upgrade` then brings each of its Souls across:
//
//   - A Soul of today's client is one `config.souls` names active whose token in credentials.json is not a v2 token.
//   - It is paired again through W2 with one approval by its owner. The request names the Soul's former id and its world
//     (`former`, `world`); the directory pairs the Soul X11 brought over for that former id, and only for the account
//     that owns it, and its answer says the former id back (`{token, grant, former}`).
//   - Then: the new token is kept under the new id; the old entry moves, untouched, to `formerly` in credentials.json
//     (the one file that holds tokens); the world gets its `gateway`; `aliases.json` maps the former id to the new one
//     (R14); and the Soul's folder takes its new id by a rename, every file in it as it was. (Not a link: R14's memory
//     refuses a folder reached through a symlink, rightly.)
//   - config.json as it was before the first change is kept in `upgrade/config-before.json`; `upgrade.json` records
//     which Soul became which.
//
// `upgrade --rollback` puts today's client back: its bundle, its config, its tokens and its folders' names. The new
// tokens are parked in credentials.json (`upgraded`), so a later upgrade restores them with no second approval. No
// memory file is written either way. A token never reaches an argument, a log line, an error or any file but credentials.json.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIALS, Refused, findHome } from '../home/home.mjs';
import { localId } from '../pair/pair.mjs';
import { pairAddress } from '../pair/address.mjs';

export const RECORD = 'upgrade.json';
const RECORD_VERSION = 'souls-upgrade/1';
const ALIASES = 'aliases.json', ALIASES_VERSION = 'souls-aliases/1';
const BEFORE = join('upgrade', 'config-before.json');
const V2_TOKEN = /^soul-[0-9a-f]{32}-\d+\.[0-9a-f]{64}$/;
const SOUL_ID = /^s_[A-Za-z0-9_-]+$/;
const VERSION_LINE = /^const VERSION = "([0-9.]+)";$/m;
const SKILL_COPIES = ['SKILL.md', '.claude/skills/souls/SKILL.md', '.agents/skills/souls/SKILL.md'];
const SELF = fileURLToPath(import.meta.url);

function readJson(file, fallback = {}) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Refused('home-unreadable', `${file.endsWith(CREDENTIALS) ? CREDENTIALS : file} cannot be read`);
  }
}
function put(file, bytes, mode) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}
const putJson = (file, value, mode = 0o600) => put(file, JSON.stringify(value, null, 2) + '\n', mode);
const credentialsOf = (home) => ({ souls: {}, ...readJson(join(home, CREDENTIALS)) });

/** Where a world's v2 directory and gateway are, from the address today's home knows it by. */
export async function endpointsOf(url, get = fetch) {
  let at;
  try { at = new URL(url); } catch { throw new Refused('pair-world-routing', 'the saved world address is invalid; the home is unchanged'); }
  const loopback = at.protocol === 'http:' && (['localhost', '[::1]'].includes(at.hostname) || at.hostname.endsWith('.localhost') || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(at.hostname));
  const installed = /^\/(preview\/)?w\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/.test(at.pathname);
  if ((!installed && !loopback) || (at.protocol !== 'https:' && !loopback)) throw new Refused('pair-world-routing', 'save the canonical or preview world address before upgrading; the home is unchanged');
  return pairAddress(url, get);
}

/** The old database identity is not this home's nickname or its public URL slug. */
function formerWorldOf(home, old, world) {
  const valid = (id) => typeof id === 'string' && id.length > 0 && id.length <= 256
    && id === id.trim() && !/[\u0000-\u001f\u007f]/.test(id);
  const ids = [];
  if (world.worldId !== undefined) {
    if (!valid(world.worldId)) throw new Refused('former-world-invalid', 'the saved old world identity is invalid; the home is unchanged');
    ids.push(world.worldId);
  }
  // Released homes keep their Soul's current world in this noncredential runtime state.
  // A visit elsewhere cannot identify its home world: only the configured URL may supply a fallback.
  const file = join(home, 'souls', old, 'runtime', 'state.json');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Refused('former-world-unreadable', 'the saved old world state cannot be read; the home is unchanged');
  }
  if (state?.world === world.url && state.worldId !== undefined) {
    if (!valid(state.worldId)) throw new Refused('former-world-invalid', 'the saved old world identity is invalid; the home is unchanged');
    ids.push(state.worldId);
  }
  if (!ids.length) throw new Refused('former-world-missing', 'the saved old world identity is missing; recover its world configuration before upgrading; the home is unchanged');
  if (new Set(ids).size !== 1) throw new Refused('former-world-conflict', 'saved identities for the same old world disagree; the home is unchanged');
  return ids[0];
}

/** Today's Souls in the home: active in config.json, with a token that is not a v2 token. */
export function formerSouls(home) {
  const config = readJson(join(home, 'config.json')), creds = credentialsOf(home);
  return Object.entries(config.souls ?? {}).filter(([id, e]) => SOUL_ID.test(id) && e?.state === 'active').flatMap(([id, e]) => {
    const world = Object.keys(creds.souls[id] ?? {}).find((k) => typeof creds.souls[id][k]?.token === 'string' && !V2_TOKEN.test(creds.souls[id][k].token));
    const saved = world && config.worlds?.[world], url = saved?.url;
    if (!world) return [];
    if (!url) throw new Refused('former-world-missing', 'the saved old world address is missing; the home is unchanged');
    return [{ old: id, name: e.name ?? id, world, formerWorld: formerWorldOf(home, id, saved), url }];
  });
}

/** The record of which Soul became which. */
export const recordOf = (home) => readJson(join(home, RECORD), { version: RECORD_VERSION, souls: {} });

/**
 * W2's device grant for one former Soul: asks with its former id and world, calls `onAsk({link, code})`, polls until
 * the owner approves, and resolves to `{token, grant, former}` with the former id the directory said back.
 */
export async function pairFormer({ directory, world, former, device, label, onAsk, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const at = new URL(directory);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(at.hostname) || at.hostname.endsWith('.localhost');
  if (at.protocol !== 'https:' && !(at.protocol === 'http:' && loopback)) throw new Refused('directory-not-https', 'the directory must be https, or http on this machine');
  const post = async (path, body) => (await fetch(new URL(path, directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const secret = randomBytes(32).toString('hex');
  const asked = await post('/v1/pair/request', {
    secret_hash: createHash('sha256').update(secret).digest('hex'), device, label, scope: 'soul', force: false, world, former,
  });
  if (asked.refused) throw new Refused(asked.refused, 'the directory refused the request');
  onAsk?.({ link: asked.link, code: asked.code });
  let interval = asked.interval ?? 5;
  for (;;) {
    await wait(interval * 1000);
    const got = await post('/v1/pair/poll', { secret });
    if (got.pending === 'slow_down') { interval = Math.max(got.interval ?? 0, interval + 5); continue; }
    if (got.pending) continue;
    if (got.refused) throw new Refused(got.refused, got.device ? `connected to ${got.device}` : 'refused');
    if (typeof got.token !== 'string' || typeof got.grant !== 'string') throw new Refused('pair-answer', 'no token in the answer');
    // The directory names the Soul it paired by its former id: any other is not this Soul, and nothing is kept.
    if (got.former !== former) throw new Refused('not-the-former-soul', `the directory paired another Soul than ${former}`);
    return got;
  }
}

/** One Soul's crossing, all synchronous so two answers in one process never interleave their writes. */
function keep(home, soul, { token, grant }, gateway) {
  const now = localId(grant), configFile = join(home, 'config.json'), credFile = join(home, CREDENTIALS);
  if (!existsSync(join(home, BEFORE))) put(join(home, BEFORE), readFileSync(configFile), 0o600);
  const creds = credentialsOf(home);
  creds.souls[now] = { ...creds.souls[now], [soul.world]: { token } };
  if (creds.souls[soul.old]) {
    creds.formerly = { souls: { ...creds.formerly?.souls, [soul.old]: creds.souls[soul.old] } };
    delete creds.souls[soul.old];
  }
  putJson(credFile, creds);
  const config = readJson(configFile);
  config.worlds[soul.world] = { ...config.worlds[soul.world], gateway };
  putJson(configFile, config, 0o600);
  const aliases = readJson(join(home, ALIASES), { version: ALIASES_VERSION, ids: {} });
  aliases.ids = { ...aliases.ids, [soul.old]: now };
  putJson(join(home, ALIASES), aliases, 0o644);
  move(home, soul.old, now);
  const record = recordOf(home);
  putJson(join(home, RECORD), { ...record, version: RECORD_VERSION, souls: { ...record.souls, [soul.old]: now } }, 0o644);
  return now;
}

/** The Soul's folder, `souls/<from>`, is renamed `souls/<to>`: its files are the same files. Never over another. */
function move(home, from, to) {
  const a = join(home, 'souls', from), b = join(home, 'souls', to);
  if (!existsSync(a) || existsSync(b)) return false;
  renameSync(a, b);
  return true;
}

/** After a rollback, the parked new tokens come back with no approval. */
function restoreParked(home, souls, addresses) {
  const record = recordOf(home), creds = credentialsOf(home), came = [];
  for (const s of souls) {
    const now = record.souls[s.old];
    if (!now || !creds.upgraded?.souls?.[now]) continue;
    creds.souls[now] = creds.upgraded.souls[now];
    delete creds.upgraded.souls[now];
    creds.formerly = { souls: { ...creds.formerly?.souls, [s.old]: creds.souls[s.old] } };
    delete creds.souls[s.old];
    came.push({ formerly: s.old, soul: now });
  }
  if (!came.length) return came;
  putJson(join(home, CREDENTIALS), creds);
  if (!existsSync(join(home, BEFORE))) put(join(home, BEFORE), readFileSync(join(home, 'config.json')), 0o600);
  const config = readJson(join(home, 'config.json'));
  for (const s of souls.filter((x) => came.some((c) => c.formerly === x.old))) config.worlds[s.world] = { ...config.worlds[s.world], gateway: addresses.get(s.url).gateway };
  putJson(join(home, 'config.json'), config, 0o600);
  for (const c of came) move(home, c.formerly, c.soul);
  return came;
}

/**
 * Brings every Soul of today's client across. `onAsk({formerly, name, link, code})` is called once per Soul that needs
 * its owner's approval. Resolves to `{souls: [{formerly, soul} | {formerly, refused}]}`.
 */
export async function upgradeHome({ home, device = hostname().slice(0, 64), label = 'souls upgrade', onAsk, sleep, get = fetch }) {
  const all = formerSouls(home);
  // Validate every route before restoring even one parked token or changing any home file.
  const addresses = new Map(await Promise.all([...new Set(all.map(s => s.url))].map(async url => [url, await endpointsOf(url, get)])));
  const came = restoreParked(home, all, addresses);
  const left = all.filter((s) => !came.some((c) => c.formerly === s.old));
  const paired = await Promise.all(left.map(async (s) => {
    const { directory, gateway } = addresses.get(s.url);
    try {
      const got = await pairFormer({ directory, world: s.formerWorld, former: s.old, device, label, sleep, onAsk: (a) => onAsk?.({ formerly: s.old, name: s.name, ...a }) });
      return { formerly: s.old, soul: keep(home, s, got, gateway) };
    } catch (e) {
      return { formerly: s.old, refused: e.code ?? 'failed' };
    }
  }));
  return { souls: [...came, ...paired] };
}

/**
 * `upgrade --rollback`: today's client again, as the last upgrade found it. Refused when the home keeps no previous
 * client. The client left is skipped by today's `upgrade` until a world serves a newer one, as today's rollback does.
 */
export function rollbackHome(home, { running } = {}) {
  const configFile = join(home, 'config.json'), config = readJson(configFile), prev = config.previousClient;
  const kept = prev ? join(home, 'bin', `eden-${prev}.mjs`) : null;
  if (!kept || !existsSync(kept)) throw new Refused('nothing-to-roll-back', 'this home keeps no previous client');
  const record = recordOf(home), creds = credentialsOf(home), left = config.client;
  for (const [old, now] of Object.entries(record.souls)) {
    if (creds.formerly?.souls?.[old]) { creds.souls[old] = creds.formerly.souls[old]; delete creds.formerly.souls[old]; }
    if (creds.souls[now]) { creds.upgraded = { souls: { ...creds.upgraded?.souls, [now]: creds.souls[now] } }; delete creds.souls[now]; }
    move(home, now, old);
  }
  putJson(join(home, CREDENTIALS), creds);
  const restored = existsSync(join(home, BEFORE)) ? readJson(join(home, BEFORE)) : config;
  Object.assign(restored, { skippedClient: left, client: prev });
  delete restored.previousClient;
  delete restored.previousSkill;
  putJson(configFile, restored, 0o600);
  rmSync(join(home, BEFORE), { force: true });
  // The bundle, and the folder's copy (or the one running) while it holds the client left.
  const bytes = readFileSync(kept), folder = dirname(home);
  const holdsLeft = (f) => { try { return VERSION_LINE.exec(readFileSync(f, 'utf8'))?.[1] === left; } catch { return false; } };
  put(join(home, 'bin', 'eden.mjs'), bytes, 0o755);
  for (const f of new Set([join(folder, 'eden.mjs'), running].filter(Boolean))) if (holdsLeft(f)) put(f, bytes, 0o755);
  // The skill the upgrade replaced, where a copy holds a newer one.
  const skill = config.previousSkill ? join(home, 'bin', `skill-${config.previousSkill}.md`) : null;
  if (skill && existsSync(skill)) {
    for (const rel of SKILL_COPIES) if (existsSync(join(folder, rel))) copyFileSync(skill, join(folder, rel));
    rmSync(skill, { force: true });
  }
  rmSync(kept, { force: true });
  return { rolledBack: true, from: left, to: prev, souls: Object.keys(record.souls).length, skipping: left };
}

const ROLLBACK_NOTE = 'Today\'s client is back with its Souls; its upgrade passes over the client left until a world serves a newer one.';

/**
 * The command: `upgrade` starts the crossing detached (its lines in `<home>/upgrade.log`) and returns each owner's link
 * and code; `upgrade --rollback` rolls back. `--finish` is the detached half.
 */
export async function main(argv, { cwd = process.cwd(), env = process.env, running = process.argv[1], within = 15_000 } = {}) {
  const home = findHome({ cwd, env, homedir: homedir() });
  if (argv.includes('--rollback')) return { ok: true, ...rollbackHome(home, { running }), note: ROLLBACK_NOTE };
  if (argv.includes('--finish')) {
    const say = (v) => process.stdout.write(JSON.stringify(v) + '\n');
    const out = await upgradeHome({ home, onAsk: (a) => say({ ok: true, step: 'approve', ...a, say: 'Open the link signed in, check the code matches, and approve.' }) });
    return { ok: out.souls.every((s) => s.soul), done: true, ...out };
  }
  const souls = formerSouls(home);
  if (!souls.length) return { ok: true, upgraded: false, note: 'No Soul of today\'s client is left in this home.' };
  const log = join(home, 'upgrade.log');
  writeFileSync(log, '', { mode: 0o600 });
  const fd = openSync(log, 'a');
  spawn(process.execPath, [SELF, '--finish'], {
    detached: true, stdio: ['ignore', fd, fd], cwd, env: { PATH: env.PATH ?? '', SOULS_HOME: home },
  }).unref();
  for (const until = Date.now() + within; Date.now() < until;) {
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const asks = lines.filter((l) => l.step === 'approve'), done = lines.find((l) => l.done);
    if (done) return done;
    if (asks.length === souls.length) {
      return { ok: true, upgrading: souls.length, asks: asks.map(({ formerly, name, link, code }) => ({ formerly, name, link, code })),
        then: 'Each Soul crosses once its owner approves its link; the upgrade goes on in the background (upgrade.log).' };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Refused('directory-not-answering', 'no answer from the directory');
}

if (process.argv[1] === SELF) {
  const argv = process.argv.slice(2);
  try {
    process.stdout.write(JSON.stringify(await main(argv)) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, code: e.code ?? 'failed', detail: String(e.message ?? e).slice(0, 200) }) + '\n');
    process.exitCode = 1;
  }
}

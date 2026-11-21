// The served client upgrades itself (Engine v2 R17, #2818), from what its world serves (v2/client/served/build.mjs)
// under today's frozen names (docs/architecture/api.md, "Soul client upgrade"): `/v1/config`'s `soulClient`, `/eden.mjs`,
// `/skill.md`, and beside them the daemon's library (`replica.js`, `replica_bg.wasm`) named in `soulClient.files`.
// The command `upgrade` is the loader's (v2/client/served/loader.mjs): this module's bundle step, then R18's `main`
// (`./upgrade.mjs`, which brings a home's Souls of today's client across); `upgrade --rollback` is R18's `main`, then
// `handOver`.
//
// The home keeps today's record (tools/world-launcher/soul/home.mjs `installBundle`), so either client reads it:
// `config.client` is the version in use, the one replaced is `bin/eden-<version>.mjs` and `config.previousClient`, its
// skill `bin/skill-<version>.md` and `config.previousSkill`. Added: `config.clientSite`, the home's one trusted site
// (the world address its first `pair` named; else the first world of a trusted origin, for a home today's client
// brought), and `config.clientLib`, each kept version's library folder, `.souls/bin/lib/<the wasm's sha256, 16 hex>/`.
//
// Carried over (docs/architecture/souls.md, "The Souls home"): only that site is asked; no redirect is followed
// (`upgrade.redirect`); every file is checked by length, hash and (client and skill) version before anything is
// written (`upgrade.mismatch`, the home left byte for byte as it was); one version is kept back; a running daemon
// hands over: it is stopped, and the new client starts the Soul's next one. Each intent's sequence is on disk before
// it is sent and nothing resends it (R6), so no intent goes twice.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request } from '../daemon/client.mjs';
import { Refused, runtimeOf, soulsWithTokens } from '../home/home.mjs';

export const LIB = ['replica.js', 'replica_bg.wasm'];
const SKILL_COPIES = ['SKILL.md', '.claude/skills/souls/SKILL.md', '.agents/skills/souls/SKILL.md'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const num = (v) => String(v).split('.').map(Number);
/** Whether version `a` is above `b` (x.y.z, by number); anything is above no version. */
export function newer(a, b) {
  if (!b) return true;
  const x = num(a), y = num(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
/** The client's version line, the first `const VERSION = "x.y.z";` at the start of a line. */
export const clientVersion = (text) => /^const VERSION = "(\d+\.\d+\.\d+)";$/m.exec(text)?.[1];
const skillVersion = (text) => /^---\n[\s\S]*?^\s*version:\s*"?([0-9][0-9.]*)"?\s*$/m.exec(text)?.[1];

/** The site a world url names: its origin and path, with no query, fragment or trailing slash. */
export function siteOf(url) {
  let u;
  try { u = new URL(url); } catch { throw new Refused('upgrade.not-a-url', String(url).slice(0, 80)); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Refused('upgrade.not-a-url', u.protocol);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

async function get(site, path) {
  let r;
  try {
    r = await fetch(`${site}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Refused('upgrade.unreachable', `${path}: ${e.cause?.code ?? e.message}`);
  }
  if (path === '/v1/config' && r.headers.get('x-souls-engine') === 'old') throw new Refused('world.previous-engine', 'This world has rolled back to the previous engine. Run: node eden.mjs upgrade --rollback');
  if (r.status >= 300 && r.status < 400) throw new Refused('upgrade.redirect', `${path} answered ${r.status}; no redirect is followed`);
  if (r.status !== 200) throw new Refused('upgrade.not-served', `${path} answered ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** What the site serves: its `soulClient`. */
export async function servedBy(site) {
  let c;
  try { c = JSON.parse(await get(site, '/v1/config')).soulClient; } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused('upgrade.not-a-world', '/v1/config is not JSON');
  }
  if (typeof c?.version !== 'string') throw new Refused('upgrade.not-a-world', '/v1/config has no soulClient');
  return c;
}

/** Fetches `names` of what `c` describes, each checked before the next is asked for. */
export async function fetchChecked(site, c, names = ['eden.mjs', 'skill.md', ...LIB]) {
  const described = { 'eden.mjs': [c, clientVersion], 'skill.md': [c.skill, skillVersion] };
  const got = {};
  for (const name of names) {
    const [d, versionOf] = described[name] ?? [c.files.find((f) => f.name === name)];
    if (!d) throw new Refused('upgrade.not-served', `${name} is not in soulClient`);
    const b = await get(site, `/${name}`);
    const why = b.length !== d.bytes ? `${b.length} bytes, not ${d.bytes}`
      : sha256(b) !== d.sha256 ? `its hash is not ${d.sha256}`
        : versionOf && versionOf(b.toString('utf8')) !== d.version ? `it does not say version ${d.version}` : null;
    if (why) throw new Refused('upgrade.mismatch', `${name}: ${why}; nothing was written`);
    got[name] = b;
  }
  return got;
}

const configFile = (home) => join(home, 'config.json');
export function readConfig(home) {
  try { return JSON.parse(readFileSync(configFile(home), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Refused('home-unreadable', 'config.json cannot be read');
  }
}
function updateConfig(home, f) {
  const cfg = readConfig(home);
  f(cfg);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(`${configFile(home)}.tmp`, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${configFile(home)}.tmp`, configFile(home));
  return cfg;
}

/** The home's one trusted site: the first pair's, else the first world of an origin today's client trusted. */
export function siteOfHome(cfg) {
  if (cfg.clientSite) return cfg.clientSite;
  const w = Object.values(cfg.worlds ?? {}).find((x) => { try { return (cfg.trustedOrigins ?? []).includes(new URL(x.url).origin); } catch { return false; } });
  return w ? siteOf(w.url) : null;
}

/** Writes the library by its hash, once; gives its folder's name. */
function putLib(home, got) {
  const lib = sha256(got['replica_bg.wasm']).slice(0, 16), dir = join(home, 'bin', 'lib', lib);
  if (!existsSync(join(dir, LIB[1]))) {
    rmSync(`${dir}.tmp`, { recursive: true, force: true });
    mkdirSync(`${dir}.tmp`, { recursive: true });
    for (const n of LIB) writeFileSync(join(`${dir}.tmp`, n), got[n]);
    rmSync(dir, { recursive: true, force: true });
    renameSync(`${dir}.tmp`, dir);
  }
  return lib;
}

/** Writes what `fetchChecked` gave: the library, then the client and skill replaced kept back, then the new ones. */
function install(home, site, c, got) {
  const bin = join(home, 'bin'), inUse = join(bin, 'eden.mjs');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const lib = putLib(home, got), was = readConfig(home);
  for (const n of ['eden.mjs', 'skill.md']) writeFileSync(join(bin, `.${n}.next`), got[n]);
  for (const f of readdirSync(bin)) if (/^(eden|skill)-[0-9.]+\.(mjs|md)$/.test(f)) rmSync(join(bin, f));
  const keep = /^[0-9.]+$/.test(was.client ?? '') && existsSync(inUse);
  if (keep) renameSync(inUse, join(bin, `eden-${was.client}.mjs`));
  const skill = join(bin, 'skill.md'), keptSkill = keep && existsSync(skill) ? skillVersion(readFileSync(skill, 'utf8')) : null;
  if (keptSkill) renameSync(skill, join(bin, `skill-${keptSkill}.md`));
  for (const n of ['eden.mjs', 'skill.md']) renameSync(join(bin, `.${n}.next`), join(bin, n));
  const cfg = updateConfig(home, (x) => {
    x.client = c.version;
    x.previousClient = keep ? was.client : null;
    if (keptSkill) x.previousSkill = keptSkill; else delete x.previousSkill;
    delete x.skippedClient;
    x.clientSite = site;
    x.clientLib = Object.fromEntries(Object.entries({ ...x.clientLib, [c.version]: lib }).filter(([v]) => v === c.version || v === x.previousClient));
  });
  for (const rel of SKILL_COPIES) { const f = join(dirname(home), rel); if (existsSync(f)) writeFileSync(f, got['skill.md']); }
  prune(home, cfg);
  return cfg;
}

/** Keeps the library and unpacked client of the version in use and the one kept back; removes the others. */
function prune(home, cfg) {
  const keep = [cfg.client, cfg.previousClient].filter(Boolean), libs = Object.values(cfg.clientLib ?? {});
  const at = (d) => { try { return readdirSync(d); } catch { return []; } };
  for (const d of at(join(home, 'bin', 'lib'))) if (!libs.includes(d)) rmSync(join(home, 'bin', 'lib', d), { recursive: true, force: true });
  for (const d of at(join(home, 'bin', 'client'))) if (!keep.includes(d.split('-')[0])) rmSync(join(home, 'bin', 'client', d), { recursive: true, force: true });
}

/**
 * The first `pair` in a home with no client: the world's address becomes its one trusted site, and what it serves
 * is installed. A home that has a site already is left alone.
 */
export async function firstInstall({ home, url }) {
  if (siteOfHome(readConfig(home))) return null;
  const site = siteOf(url), c = await servedBy(site);
  if (!Array.isArray(c.files) || !c.skill) throw new Refused('upgrade.not-served', `${site} serves no client files`);
  return install(home, site, c, await fetchChecked(site, c));
}

/**
 * The library for `version`'s daemon, folder name: kept, else fetched from the home's site when it serves that
 * version (a home today's client upgraded has the bundle but not yet the library). Null when there is none.
 */
export async function libFor(home, version) {
  const cfg = readConfig(home);
  if (cfg.clientLib?.[version] && existsSync(join(home, 'bin', 'lib', cfg.clientLib[version]))) return cfg.clientLib[version];
  const site = siteOfHome(cfg);
  if (!site) return null;
  const c = await servedBy(site);
  if (c.version !== version || !Array.isArray(c.files)) return null;
  const lib = putLib(home, await fetchChecked(site, c, LIB));
  updateConfig(home, (x) => { x.clientSite ??= site; x.clientLib = { ...x.clientLib, [version]: lib }; });
  return lib;
}

/** Whether the home's client is this one (a v2 bundle), so its daemon can be started. */
const isServedClient = (file) => { try { return /^const FILES = /m.test(readFileSync(file, 'utf8')); } catch { return false; } };

/**
 * Stops each Soul's running daemon, and, when the home's client is a served v2 client, starts the next from it;
 * gives each Soul handed over.
 */
export async function handOver(home, { within = 10_000 } = {}) {
  const moved = [], start = isServedClient(join(home, 'bin', 'eden.mjs'));
  for (const soul of soulsWithTokens(home)) {
    const rt = runtimeOf(home, soul);
    if (!existsSync(rt.lock)) continue;
    try { await request(rt.socket, { op: 'stop' }); } catch { continue; }   // a lock left by a process that ended
    for (const until = Date.now() + within; existsSync(rt.lock) && Date.now() < until;) await new Promise((r) => setTimeout(r, 25));
    if (!start) { moved.push({ soul, started: false, ok: true }); continue; }
    const env = { ...process.env, SOULS_HOME: home };
    delete env.SOULS_REPLICA_PKG;
    const r = spawnSync(process.execPath, [join(home, 'bin', 'eden.mjs'), 'status', '--soul', soul], { encoding: 'utf8', env, timeout: within });
    let status = null;
    try { status = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* said nothing */ }
    moved.push({ soul, started: status?.started === true, ok: status?.ok !== false });
  }
  return moved;
}

/**
 * `upgrade`'s bundle step: a newer client from the home's site, installed and handed over. Passes over the client a
 * rollback left until the site serves a newer one. A home with no site yet has nothing to fetch.
 */
export async function upgradeBundle({ home, version }) {
  const cfg = readConfig(home), site = siteOfHome(cfg), have = cfg.client ?? version;
  if (!site) return { current: true, version: have, note: 'no site yet: pair a Soul first' };
  const c = await servedBy(site);
  // A world that serves no files beside its client (today's, or a stand-in) has nothing for this step.
  if (!Array.isArray(c.files) || !c.skill || !newer(c.version, have) || c.version === cfg.skippedClient) {
    await libFor(home, have).catch(() => null);
    return { current: true, version: have, served: c.version };
  }
  const now = install(home, site, c, await fetchChecked(site, c));
  return { upgraded: { from: have, to: now.client }, kept: now.previousClient ?? null, handedOver: await handOver(home) };
}

/**
 * `upgrade --rollback`: R18's `main` puts back the client kept (and, for a home that came from today's client, its
 * Souls); the skill it kept goes back to `bin/skill.md` too, and the daemons hand over.
 */
export async function rollback({ home, main, running }) {
  const cfg = readConfig(home), kept = cfg.previousSkill ? join(home, 'bin', `skill-${cfg.previousSkill}.md`) : null;
  const skill = kept && existsSync(kept) ? readFileSync(kept) : null;
  const out = await main(['--rollback'], { running, env: { ...process.env, SOULS_HOME: home } });
  if (skill) writeFileSync(join(home, 'bin', 'skill.md'), skill);
  return { ...out, handedOver: await handOver(home) };
}

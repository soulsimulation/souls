#!/usr/bin/env node
// Per-world limits (#4013 follow-up, #1960): writes worldd@<instance>.service.d/limits.conf for each world that
// units/world-limits.json names and this machine has placed. install.sh apply runs it; it starts and restarts nothing.
//
//   node world-limits.mjs plan|apply|props --config <world-limits.json> [--authority <authority.json>] [--root <folder>]
//
// The slug is turned into the placed instance by the world-authority map (register-world and placement write it). A
// world counts as placed when its drop-in folder exists (place-world.sh made it). It writes only its own files (their
// first line is HEADER): a limits.conf someone else wrote is refused, and one it wrote for a world no longer listed
// is removed. `plan` prints one line per change and changes nothing; `apply` makes them; `props` prints, for each listed
// placed world, `worldd@<instance>.service Key=Value ...` (what memory-bounds.sh sets live). --root stands in for /.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADER = '# Written by world-limits.mjs from world-limits.json';
const UNITS = '/etc/systemd/system';
const AUTHORITY = '/etc/souls/placement-data/authority.json';
const SLUG = /^(?!-)[a-z0-9-]{1,40}(?<!-)$/, INSTANCE = /^[a-f0-9]{32}-[a-f0-9]{32}-[0-9]+$/;
const MEMORY = /^[1-9][0-9]{0,5}[MG]$/;
const fail = (why) => { throw Error(`world-limits: ${why}`); };

/** The checked config: slug -> { memory_max?, memory_low?, start_within_s? }. */
export function parseConfig(text) {
  const c = JSON.parse(text);
  if (c.format !== 'souls/world-limits/1' || typeof c.worlds !== 'object' || !c.worlds) fail('config is not souls/world-limits/1');
  for (const [slug, l] of Object.entries(c.worlds)) {
    if (!SLUG.test(slug)) fail(`${slug}: not a slug`);
    for (const k of Object.keys(l)) if (!['memory_max', 'memory_low', 'start_within_s'].includes(k)) fail(`${slug}: unknown limit ${k}`);
    if (l.memory_max !== undefined && !MEMORY.test(l.memory_max)) fail(`${slug}: memory_max is a MemoryMax such as 8G`);
    if (l.memory_low !== undefined && !MEMORY.test(l.memory_low)) fail(`${slug}: memory_low is a MemoryLow such as 2G`);
    const s = l.start_within_s;
    if (s !== undefined && !(Number.isInteger(s) && s >= 1 && s <= 3600)) fail(`${slug}: start_within_s is 1 to 3600`);
  }
  return c.worlds;
}

/** The drop-in's text for one world. deploy reads WORLD_START_WITHIN_S from it (supervisor::deploy::start_within). */
export function render(slug, l) {
  const lines = [`${HEADER} (world ${slug}); edit that file, not this one.`, '[Service]'];
  if (l.memory_max) lines.push(`MemoryMax=${l.memory_max}`);
  if (l.memory_low) lines.push(`MemoryLow=${l.memory_low}`);
  if (l.start_within_s) lines.push(`Environment=WORLD_START_WITHIN_S=${l.start_within_s}`);
  return `${lines.join('\n')}\n`;
}

/** The listed worlds placed here: [{ slug, instance }]. */
function placedWorlds(worlds, authority, root, units) {
  const placed = authority?.worlds ?? {};
  const out = [];
  for (const slug of Object.keys(worlds)) {
    const instance = placed[slug]?.instance;
    if (instance === undefined) continue; // not on this machine
    if (!INSTANCE.test(instance)) fail(`${slug}: the authority map's instance is not a world instance`);
    if (!existsSync(join(root + units, `worldd@${instance}.service.d`))) continue; // registered, not placed here
    out.push({ slug, instance });
  }
  return out;
}

/** The memory properties to set live on each listed placed world: [{ unit, props: ['MemoryMax=4G', ...] }]. */
export function props(worlds, authority, root = '', units = UNITS) {
  return placedWorlds(worlds, authority, root, units)
    .map(({ slug, instance }) => ({ unit: `worldd@${instance}.service`, props: render(slug, worlds[slug]).split('\n').filter((l) => /^Memory(Max|Low)=/.test(l)) }))
    .filter((p) => p.props.length);
}

/** What apply would do: [{ op: 'file' | 'remove', path, text?, why }], paths as on the machine (without root). */
export function changes(worlds, authority, root = '', units = UNITS) {
  // No map yet (a fresh install's plan): no world is placed, and nothing is removed on its account.
  if (!authority) return [];
  const want = new Map();
  for (const { slug, instance } of placedWorlds(worlds, authority, root, units)) {
    want.set(`${units}/worldd@${instance}.service.d/limits.conf`, { slug, text: render(slug, worlds[slug]) });
  }
  const out = [];
  for (const [path, { slug, text }] of want) {
    const now = existsSync(root + path) ? readFileSync(root + path, 'utf8') : null;
    if (now === text) continue;
    if (now !== null && !now.startsWith(HEADER)) fail(`${path} was not written by world-limits.mjs; move it aside first`);
    out.push({ op: 'file', path, text, why: `${slug}: ${text.split('\n').slice(2).filter(Boolean).join(' ')}` });
  }
  // Its own files for worlds no longer listed go, so a world returns to the unit's limits.
  const dirs = existsSync(root + units) ? readdirSync(root + units).filter((d) => /^worldd@.+\.service\.d$/.test(d)) : [];
  for (const d of dirs.sort()) {
    const path = `${units}/${d}/limits.conf`;
    if (want.has(path) || !existsSync(root + path)) continue;
    if (readFileSync(root + path, 'utf8').startsWith(HEADER)) out.push({ op: 'remove', path, why: 'no longer listed' });
  }
  return out;
}

export function apply(list, root = '') {
  for (const c of list) {
    if (c.op === 'remove') rmSync(root + c.path);
    else {
      writeFileSync(`${root + c.path}.new`, c.text, { mode: 0o644 });
      renameSync(`${root + c.path}.new`, root + c.path);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [mode, ...rest] = process.argv.slice(2);
  const arg = (n, d) => { const i = rest.indexOf(n); return i < 0 ? d : rest[i + 1]; };
  try {
    if (!['plan', 'apply', 'props'].includes(mode)) fail('plan|apply|props --config <file> [--authority <file>] [--root <folder>]');
    const root = arg('--root', '');
    const config = arg('--config') ?? fail('--config <world-limits.json> is needed');
    const auth = arg('--authority', root + AUTHORITY);
    const authority = existsSync(auth) ? JSON.parse(readFileSync(auth, 'utf8')) : null;
    const worlds = parseConfig(readFileSync(config, 'utf8'));
    if (mode === 'props') {
      for (const p of props(worlds, authority, root)) console.log(`${p.unit} ${p.props.join(' ')}`);
      process.exit(0);
    }
    const list = changes(worlds, authority, root);
    if (mode === 'apply') apply(list, root);
    for (const c of list) console.log(`${c.op} ${c.path} (${c.why})`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

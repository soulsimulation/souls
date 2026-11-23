// A Soul's memory comes with it (Engine v2 R14, #2754). The memory is the Soul's own and lives at the edge, in its
// home: `.souls/souls/<id>/memory/` (an append-only log and the projections made from it), `MEMORY.md` beside it.
// Nothing here talks to a world or a server, and nothing about memory goes into the replica.
//
// The record format, its validators and budgets, people, the brief, `digest` and `consolidate` are the shipping line's
// modules, in `../soul/` (moved from tools/world-launcher/soul/ in 0.134 D3; today's client re-exports them from there
// and inlines them): they read no world, and one copy can't drift from the other. What is new for v2 is the feeder
// (`feeder.mjs`), and the alias table read here.
//
// Ids change at the clean start. Old records keep old ids as text and are never rewritten. The home holds one alias
// file, `aliases.json` (R18 fills it from X11's table):
//
//   { "version": "souls-aliases/1", "ids": { "<old id>": "<new id>", ... } }
//
// The feeder writes a new id that has an alias as its old one, so a person or a place known before keeps one file and
// one row; reading goes the other way, and an old id with no alias reads as "formerly <id>".

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTION_BUDGETS, openMemoryFolder } from '../soul/memory-folder.mjs';
import { openSoulMemory } from '../soul/memory.mjs';
import { digest, readLog, renderDigest } from '../soul/digest.mjs';
import { answerOf, consolidate, fakeMind, ownerMind, settingsOf } from '../soul/consolidate.mjs';
import { worldsOf } from '../home/home.mjs';

export { openSoulMemory, readLog };

export const ALIASES = 'aliases.json';
const ALIASES_VERSION = 'souls-aliases/1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;

/** The Soul's folder in the home. */
export const soulDirOf = (home, soul) => join(home, 'souls', soul);

/**
 * The home's alias table, both ways. No file is an empty table; a file that is not one (a bad id, an id named twice
 * either way) is refused whole, so no record is written under a guess.
 */
export function readAliases(home) {
  const file = join(home, ALIASES), toNew = new Map(), toOld = new Map();
  if (!existsSync(file)) return { toNew, toOld };
  let table;
  try { table = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`memory: ${ALIASES} is not JSON`); }
  if (table?.version !== ALIASES_VERSION || !table.ids || typeof table.ids !== 'object' || Array.isArray(table.ids)) {
    throw new Error(`memory: ${ALIASES} is not ${ALIASES_VERSION}`);
  }
  for (const [old, now] of Object.entries(table.ids)) {
    if (!SAFE_ID.test(old) || typeof now !== 'string' || !SAFE_ID.test(now)) throw new Error(`memory: ${ALIASES} has an id that is not one`);
    if (toOld.has(now)) throw new Error(`memory: ${ALIASES} names ${now} twice`);
    toNew.set(old, now);
    toOld.set(now, old);
  }
  return { toNew, toOld };
}

/** Day pages consolidation summarized stay out of the projections, as the shipping line's opener keeps them. */
function journalAfter(soulDir) {
  try { return JSON.parse(readFileSync(join(soulDir, 'memory', 'consolidation.json'), 'utf8')).through ?? null; } catch { return null; }
}

/**
 * Who and where this memory knows, read through the alias table: an aliased old id shows its new one (`was` the old),
 * an id the new world knows (`current(id)`) shows as it is, and any other old id stays readable as "formerly".
 * A place is held as `<world>:<place>`; the table names the place as its world did.
 */
export function knownThrough(soulDir, { aliases, current = () => false }) {
  const known = openMemoryFolder(soulDir, {
    logs: join('memory', 'log'), personFiles: false, journalAfter: journalAfter(soulDir), budgets: PROJECTION_BUDGETS,
  }).known();
  const through = (id, name, bare = id) => {
    const now = aliases.toNew.get(bare);
    if (now) return { id: now, name, was: id };
    if (current(bare) || aliases.toOld.has(bare)) return { id, name };
    return { id, name, formerly: true, shown: `${name} (formerly ${id})` };
  };
  return {
    people: known.people.map((p) => ({ ...through(p.id, p.name), met: p.met })),
    places: known.places.map((p) => through(p.id, p.name, p.id.slice(p.id.indexOf(':') + 1))),
  };
}

/** `digest [--since <time>] [--refs]`: at most 200 words for the owner from the log alone; no request, no model. */
export function digestOf(soulDir, { since = null, until = new Date().toISOString(), refs = false } = {}) {
  const d = digest(readLog(soulDir), { since, until });
  return { ...d, text: renderDigest(d, { refs }) };
}

/**
 * `consolidate [--force]`: the owner's opt-in pass (`consolidation.enabled` in the home's config.json). Until they say
 * yes it says so and runs nothing. A fake-mind home (`BRAIN_MODE=fake`) gets the deterministic stand-in.
 */
export async function consolidateIn(home, soulDir, { force = false, env = process.env, now } = {}) {
  let config = {};
  try { config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).consolidation ?? {}; } catch { /* none */ }
  const answer = answerOf(config);
  if (answer !== true) return { skipped: answer === false ? 'consolidation is off' : 'consolidation not asked yet: consolidate on, or off' };
  const ask = env.BRAIN_MODE === 'fake' ? async (p) => fakeMind(p) : ownerMind({ env });
  return consolidate(soulDir, { ask, caps: settingsOf(config), force, ...(now ? { now } : {}) });
}

// ---- memory and remember (Engine v2 R19, #3327): the shipping line's commands, on the same folder ------------------

/**
 * The world key the Soul's memory is written under: where it holds a token, else the world it was last seen in (its
 * presence file, `worlds/<key>.json`). A Soul with neither has no memory to open.
 */
export function worldOfSoul(home, soul) {
  const held = worldsOf(home, soul);
  if (held.length) return held[0];
  const dir = join(soulDirOf(home, soul), 'worlds');
  const seen = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ key: f.slice(0, -5), at: statSync(join(dir, f)).mtimeMs })) : [];
  const last = seen.sort((a, b) => b.at - a.at)[0];
  if (!last) throw Object.assign(new Error(`${soul} has no world yet`), { code: 'no-world' });
  return last.key;
}

/** The Soul's memory, opened as the shipping line's client opens it. */
export function memoryOf(home, soul, { now } = {}) {
  let name = null;
  try { name = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).souls?.[soul]?.name ?? null; } catch { /* none */ }
  return openSoulMemory(soulDirOf(home, soul), { world: worldOfSoul(home, soul), soul, name, ...(now ? { now } : {}) });
}

/** `memory <words>`: every line holding every word, each with where it came from and `untrusted` when a world wrote it. */
export function searchIn(home, soul, words) {
  if (!words.length) throw Object.assign(new Error('memory <words to find>'), { code: 'memory-usage' });
  return memoryOf(home, soul).search(words.join(' '));
}

const REMEMBER_USAGE = 'remember --person <id|name> "<note>" | --place <id|name> "<note>" | --goal <id> "<note>" [--horizon today|week|month] [--metric "..."] [--next "..."] | --self "<line>" | --person <id> --promise "<what>" [--by me|them] | --kept <promise id> --evidence <receipt or conversation id>';

/**
 * `remember ...`: one record through the record's validators. A person or place may be named by a new id: an id with
 * an alias is written as its old one, as the feeder writes it, so it lands on the row the Soul already has.
 */
export function rememberIn(home, soul, argv, { now } = {}) {
  const picked = {}, words = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = /^--(person|place|goal|horizon|metric|next|by|kept|evidence)$/.exec(argv[i]);
    if (flag) picked[flag[1]] = argv[++i];
    else if (argv[i] === '--self') picked.self = true;
    else if (argv[i] === '--promise') picked.promise = true;
    else words.push(argv[i]);
  }
  const usage = () => Object.assign(new Error(REMEMBER_USAGE), { code: 'remember-usage' });
  const { toOld } = readAliases(home), old = (id) => (typeof id === 'string' ? toOld.get(id) ?? id : id);
  for (const k of ['person', 'place']) if (picked[k] !== undefined) picked[k] = old(picked[k]);
  const memory = memoryOf(home, soul, { now });
  if (picked.kept) { if (!picked.evidence) throw usage(); return memory.kept(picked.kept, picked.evidence); }
  if (picked.promise) {
    if (!picked.person || !words.length || !['me', 'them', undefined].includes(picked.by)) throw usage();
    return memory.promise(picked.person, words.join(' '), picked.by ?? 'me');
  }
  const selectors = ['person', 'place', 'goal', 'self'].filter((k) => picked[k] !== undefined), note = words.join(' ');
  if (selectors.length !== 1 || !note) throw usage();
  return memory.remember(selectors[0], picked[selectors[0]], note, picked);
}

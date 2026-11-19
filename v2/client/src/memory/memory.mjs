// A Soul's memory comes with it (Engine v2 R14, #2754). The memory is the Soul's own and lives at the edge, in its
// home: `.souls/souls/<id>/memory/` (an append-only log and the projections made from it), `MEMORY.md` beside it.
// Nothing here talks to a world or a server, and nothing about memory goes into the replica.
//
// The record format, its validators and budgets, people, the brief, `digest` and `consolidate` are the shipping line's
// modules, imported in place from tools/world-launcher/soul/ (the issue's listed alternative) until X8 retires that
// folder: they read no world, and one copy can't drift from the other. What is new for v2 is the feeder
// (`feeder.mjs`), and the alias table read here.
//
// Ids change at the clean start. Old records keep old ids as text and are never rewritten. The home holds one alias
// file, `aliases.json` (R18 fills it from X11's table):
//
//   { "version": "souls-aliases/1", "ids": { "<old id>": "<new id>", ... } }
//
// The feeder writes a new id that has an alias as its old one, so a person or a place known before keeps one file and
// one row; reading goes the other way, and an old id with no alias reads as "formerly <id>".

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTION_BUDGETS, openMemoryFolder } from '../../../../tools/world-launcher/soul/memory-folder.mjs';
import { openSoulMemory } from '../../../../tools/world-launcher/soul/memory.mjs';
import { digest, readLog, renderDigest } from '../../../../tools/world-launcher/soul/digest.mjs';
import { answerOf, consolidate, fakeMind, ownerMind, settingsOf } from '../../../../tools/world-launcher/soul/consolidate.mjs';

export { openSoulMemory };

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

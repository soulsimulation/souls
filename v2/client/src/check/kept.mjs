// A form act's check inputs kept between acts (0.132 G-late follow-up): the kind entries and the state the rules read
// are rebuilt only when what they are made from changed. The copy is addressed by hash and every reader walks it from
// its roots (`copy.roots()`), so equal roots are an equal copy; the kind entries' folder is stamped by its own change.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { kindsIn } from './state.mjs';

/** One value kept for one key: `get(key, make)` makes it again only when an element of `key` (a list) differs. */
export function keptOne() {
  let key = null, value;
  return {
    get(k, make) {
      if (key === null || key.length !== k.length || k.some((x, i) => x !== key[i])) { value = make(); key = k; }
      return value;
    },
  };
}

/** How long the folder must have been still for its own change time to stand for its files. */
export const STILL_MS = 1000;
/**
 * The kind entries' folder as one text: the folder's own identity and change time; '' when there is none. Its entries
 * are written by rename (`pair/pair.mjs` `refreshEntries`), and adding, renaming or removing a file changes the folder,
 * so one stat tells a still folder: a stat of each of Eden's 415 files, at every check, held the daemon's loop 30 to
 * 250 ms a call on a loaded machine (26 Nov 2026). Within STILL_MS of a change, a later change can carry the same time
 * (Linux stamps files from a coarse clock), so each file is looked at too, by name, inode, size and change time. A
 * file rewritten in place, not renamed, in a still folder is not seen until the folder next changes.
 */
export function folderStamp(dir) {
  let s;
  try { s = statSync(dir, { bigint: true }); } catch { return ''; }
  const own = `${s.dev}:${s.ino}:${s.mtimeNs}`;
  if (Date.now() - Number(s.mtimeMs) >= STILL_MS) return own;
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return own; }
  return `${own}|${names.map((f) => { try { const t = statSync(join(dir, f), { bigint: true }); return `${f}:${t.ino}:${t.size}:${t.mtimeNs}`; } catch { return `${f}:-`; } }).join('|')}`;
}

/** `kindsIn(dir, body)` read again only when the folder's stamp or the body's kind changed: reading Eden's 415 entries
 *  took 0.4 to 0.8 s on a loaded machine, and every change to the copy read them all again. */
export function keptKinds() {
  const kept = keptOne();
  return (dir, body) => kept.get([dir, folderStamp(dir), body], () => kindsIn(dir, body));
}

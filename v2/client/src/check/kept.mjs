// A form act's check inputs kept between acts (0.132 G-late follow-up): the kind entries and the state the rules read
// are rebuilt only when what they are made from changed. The copy is addressed by hash and every reader walks it from
// its roots (`copy.roots()`), so equal roots are an equal copy; the kind entries' folder is stamped by its files.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

/** The kind entries' folder as one text: each `.json` file's name, size and change time; '' when there is none. */
export function folderStamp(dir) {
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return ''; }
  return names.map((f) => { try { const s = statSync(join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:-`; } }).join('|');
}

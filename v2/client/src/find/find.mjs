// `find` (Engine v2 R7, #2701): one search over whatever the copy holds. The scoring is today's
// (`tools/world-launcher/soul/catalog.mjs`, pure, no network), ported onto the copy's rows: a row is a node the copy
// holds, `{ id, name, kind, path }`, its name as `brief/copy.mjs` gives it. E1's world-wide index and "where is this
// Soul" are read through this same search, so there is no second one.
//
// A word scores 5 in the name, 4 in the id or an alias, 2 in the kind, 1 in what the row says it is, and a row
// missing any word scores nothing. The full name scores 100 more, a whole name standing in the words 50 more.

const byName = new Intl.Collator('en', { numeric: true }).compare;
const STOP = new Set(['the', 'a', 'an', 'to', 'into', 'onto', 'of', 'in', 'at', 'on', 'for', 'and', 'some', 'somewhere', 'place', 'go', 'walk', 'find', 'near', 'nearest', 'closest', 'me']);
export const tokensOf = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
export const stem = (w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const hit = (q, words) => words.some((w) => w === q || stem(w) === stem(q) || (q.length >= 4 && w.startsWith(q)));

/** catalog.mjs `score`: every word must hit a field; the name exactly adds 6. */
export function score(q, fields) {
  let s = 0;
  for (const w of q) {
    if (hit(w, fields.name)) s += 5;
    else if (hit(w, fields.id) || hit(w, fields.alias ?? [])) s += 4;
    else if (hit(w, fields.kind ?? [])) s += 2;
    else if (hit(w, fields.what ?? [])) s += 1;
    else return 0;
  }
  return s + (fields.name.join(' ') === q.join(' ') ? 6 : 0);
}

/** catalog.mjs `nameIn`: the length of a name of two words or more standing whole in the words, or 0. */
export function nameIn(q, name) {
  const n = name.length;
  if (n < 2 || n > q.length) return 0;
  for (let i = 0; i + n <= q.length; i++) if (name.every((w, j) => w === q[i + j])) return n;
  return 0;
}

const WORDS = new WeakMap();
const wordsOf = (row) => {
  let w = WORDS.get(row);
  if (!w) WORDS.set(row, (w = { name: tokensOf(row.name), id: tokensOf(row.id), alias: (row.aliases ?? []).flatMap(tokensOf), kind: tokensOf(row.kind), what: tokensOf(row.what) }));
  return w;
};

/** A kind entry's own words for what its things are and do (souls-entry/1): its card's category and synonyms, and its
 *  forms' names, so `find instrument` finds a piano, `find food` an apple and `find drink` a cup. They score as what
 *  the row says it is (1): below every name, id and kind. */
export function kindWordsOf(e) {
  if (!e || typeof e !== 'object') return [];
  const said = (key) => (typeof e.text?.[key] === 'string' ? e.text[key] : key);
  return [e.card?.category, ...(e.card?.synonyms ?? []).map(said), ...Object.keys(e.forms ?? {})].flatMap(tokensOf);
}

/** Where a row is, by the names above it: the nearest three that are names, not a kind and number the copy gave a
 *  nameless node (`floor 844`, `ground 1`), so a bookcase is `Living, eden-house-1`; nothing but those, the nearest two. */
export function placeName(path) {
  const named = path.filter((n) => !/^[a-z_]+ \d+$/.test(n));
  return (named.length ? named.slice(-3) : path.slice(-2)).reverse().join(', ');
}

/** The rows the words find, best first (then nearest, then by name), at most `limit`, and how many more there were.
 *  `metres(row)`, when given, is how far the row is from the asker: each found row carries it (world-wide, no radius).
 *  `kinds`, the kind entries by kind, adds each kind's words (`kindWordsOf`). */
export function find(rows, words, { limit = 8, within, metres, kinds } = {}) {
  const q = tokensOf(words), out = [], kindWords = new Map();
  if (!q.length) return { found: [], note: 'Say what to find.' };
  for (const row of rows) {
    if (within && !within.has(row.id)) continue;
    const k = row.entry ?? row.kind;
    if (kinds && !kindWords.has(k)) kindWords.set(k, kindWordsOf(kinds[k]));
    const own = wordsOf(row), kw = kindWords.get(k), w = kw?.length ? { ...own, what: [...own.what, ...kw] } : own;
    const full = w.name.join(' ') === q.join(' '), inside = nameIn(q, w.name);
    const s = full ? 100 + score(q, w) : inside ? 50 + inside : score(q, w);
    if (s) out.push({ s, row, m: metres?.(row) ?? Infinity });
  }
  out.sort((a, b) => b.s - a.s || a.m - b.m || byName(String(a.row.name), String(b.row.name)));
  const found = out.slice(0, limit).map(({ row, m }) => ({ id: row.id, name: row.name, kind: row.kind, ...(row.soul ? { soul: row.soul, parent: row.parent } : {}), ...(row.path?.length ? { in: placeName(row.path) } : {}), ...(Number.isFinite(m) ? { metres: Math.round(m) } : {}) }));
  return { found, ...(out.length > limit ? { more: out.length - limit } : {}) };
}

// `find` (Engine v2 R7, #2701): one search over whatever the copy holds. The scoring is today's
// (`tools/world-launcher/soul/catalog.mjs`, pure, no network), ported onto the copy's rows: a row is a node the copy
// holds, `{ id, name, kind, path }`, its name as `brief/copy.mjs` gives it. E1's world-wide index and "where is this
// Soul" are read through this same search, so there is no second one.
//
// A word scores 5 in the name, 4 in the id or an alias, 2 in the kind, 1 in what the row says it is, and a row
// missing any word scores nothing. The full name scores 100 more, a whole name standing in the words 50 more.

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

/** The rows the words find, best first (then by name), at most `limit`, and how many more there were. */
export function find(rows, words, { limit = 8, within } = {}) {
  const q = tokensOf(words), out = [];
  if (!q.length) return { found: [], note: 'Say what to find.' };
  for (const row of rows) {
    if (within && !within.has(row.id)) continue;
    const w = wordsOf(row), full = w.name.join(' ') === q.join(' '), inside = nameIn(q, w.name);
    const s = full ? 100 + score(q, w) : inside ? 50 + inside : score(q, w);
    if (s) out.push({ s, row });
  }
  out.sort((a, b) => b.s - a.s || String(a.row.name).localeCompare(String(b.row.name), 'en', { numeric: true }));
  const found = out.slice(0, limit).map(({ row }) => ({ id: row.id, name: row.name, kind: row.kind, ...(row.path?.length ? { in: row.path.slice(-2).reverse().join(', ') } : {}) }));
  return { found, ...(out.length > limit ? { more: out.length - limit } : {}) };
}

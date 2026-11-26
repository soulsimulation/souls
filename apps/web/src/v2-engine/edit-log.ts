// #5006 row 14: the creator's edits on a world the new engine runs, newest first, for God Mode's panel. Each committed
// edit names what it did (`sim::edit` `events_of`: `souls:placed` one a thing, `souls:moved`, `souls:changed`,
// `souls:removed`; an undo `souls:undone`, a redo `souls:redone`), and the world's archiver thread writes each named
// event's row into the public event index (V4, v2/docs/archive.md): `[at µs, kind number, node, actor]`, a creator's
// actor `[2, principal]`. This reads that index from the world's history export, as the agent's `history` does
// (v2/client/src/history/history.mjs), so nothing here asks the world and nothing runs on its clock thread. Only the
// creator's God Mode asks for it; the rows are public, as every named event's are.
import { eventsKey, DAY_US } from './history-keys.ts';
import { shortKind, type BuildNode } from './creator-build.ts';

/** How far back a page reads: the agent's `history` look-back at most (history.mjs `LOOK_BACK_MOST`). */
export const LOOK_BACK_DAYS = 7;
/** Edits a page. */
export const PAGE = 20;
export const KINDS = ['souls:placed', 'souls:moved', 'souls:changed', 'souls:removed', 'souls:undone', 'souls:redone'] as const;
export type Kind = typeof KINDS[number];

/** One row of the index by a creator: its world time (µs), kind, node (`<scope hex>.<counter>`, as the stream names
 *  it) and the creator's principal (`<scope hex>-<counter>`, as its grant names it). */
export type EditRow = { at: number; kind: Kind; node: string; creator: string };
/** One edit: its rows of one world time by one creator, in index order. */
export type Edit = { at: number; creator: string; rows: { kind: Kind; node: string }[] };
/** A page of edits, newest first, and where the next page starts (`before`), or null when the look-back holds no more. */
export type EditPage = { edits: Edit[]; before: number | null };

/** An object of the index's bytes, or null when the world has none (a 404: no public event that day). */
export type Get = (key: string) => Promise<Uint8Array | null>;
export type Decode = (bytes: Uint8Array) => unknown;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const idOf = (v: unknown): [string, number] | null => Array.isArray(v) && v.length === 2 && v[0] instanceof Uint8Array && v[0].length === 16 ? [hex(v[0]), Number(v[1])] : null;
const isKind = (k: unknown): k is Kind => (KINDS as readonly unknown[]).includes(k);

/** The creator rows of one object of the index (`{4: [kind, ...], 5: [[at, kind number, node, actor], ...], 6: [split
 *  hour, ...]}`) and the hours a day's object names as split. Rows of a Soul or of the world, and kinds no edit
 *  writes, are left out. */
export function creatorRows(obj: unknown): { rows: EditRow[]; split: number[] } {
  const out: { rows: EditRow[]; split: number[] } = { rows: [], split: [] };
  if (!(obj instanceof Map)) return out;
  const kinds = obj.get(4), rows = obj.get(5), split = obj.get(6);
  if (Array.isArray(split)) out.split = split.map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h < 24);
  if (!Array.isArray(kinds) || !Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== 4 || !Array.isArray(r[3]) || Number(r[3][0]) !== 2) continue;
    const kind = kinds[Number(r[1])], node = idOf(r[2]), creator = idOf(r[3][1]);
    if (!isKind(kind) || !node || !creator) continue;
    out.rows.push({ at: Number(r[0]), kind, node: `${node[0]}.${node[1]}`, creator: `${creator[0]}-${creator[1]}` });
  }
  return out;
}

/** A world day's creator rows: its object, then each hour it names as split. A day before today is kept in `cache`
 *  (its objects no longer change once the day has ended). */
async function dayRows(get: Get, decode: Decode, day: number, today: number, cache?: Map<number, EditRow[]>): Promise<EditRow[]> {
  const kept = cache?.get(day);
  if (kept) return kept;
  const read = async (key: string) => { const b = await get(key); return b ? creatorRows(decode(b)) : { rows: [], split: [] }; };
  const whole = await read(eventsKey(day));
  const hours = await Promise.all(whole.split.map((h) => read(eventsKey(day, h))));
  const rows = [...whole.rows, ...hours.flatMap((h) => h.rows)];
  if (day < today) cache?.set(day, rows);
  return rows;
}

/** Rows grouped into edits: one world time and one creator each, newest first. */
export function editsOf(rows: readonly EditRow[]): Edit[] {
  const by = new Map<string, Edit>();
  for (const r of rows) {
    const k = `${r.at} ${r.creator}`;
    let e = by.get(k);
    if (!e) by.set(k, e = { at: r.at, creator: r.creator, rows: [] });
    e.rows.push({ kind: r.kind, node: r.node });
  }
  return [...by.values()].sort((a, b) => b.at - a.at || a.creator.localeCompare(b.creator));
}

/** The creator's edits before world time `before` (µs; the newest when not given), newest first, at most `most`,
 *  read day by day back to `LOOK_BACK_DAYS` world days before `now`. An edit is never split across pages: the next
 *  page is the edits before the oldest one given. */
export async function editPage({ get, decode, now, before, most = PAGE, cache }: { get: Get; decode: Decode; now: number; before?: number | null; most?: number; cache?: Map<number, EditRow[]> }): Promise<EditPage> {
  const today = Math.floor(now / DAY_US), floor = today - LOOK_BACK_DAYS + 1;
  const upTo = before ?? Infinity;
  const edits: Edit[] = [];
  for (let day = Math.min(today, Math.floor(Math.min(upTo, now) / DAY_US)); day >= floor; day--) {
    edits.push(...editsOf((await dayRows(get, decode, day, today, cache)).filter((r) => r.at < upTo)));
    if (edits.length >= most) return { edits: edits.slice(0, most), before: edits[most - 1]!.at };
  }
  return { edits, before: null };
}

/** The objects of the index from the world's history export at `base` (`historyBase`, history.ts): its bytes, or null
 *  for a 404. Each is asked again of the origin (the open day's objects change as the world goes on). */
export const fetchGet = (base: string, go: typeof fetch = fetch): Get => async (key) => {
  const r = await go(new URL(key, base).href, { cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
  // a key the origin does not hold: a 404, or a bucket's 403
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`the world's history said ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

/** A node as the panel names it, from what the page's stream shows (`buildNodes`): a place by its name, the world's
 *  root and its open ground as such, a thing by its kind ("the park bench"); one the stream no longer holds, "a thing". */
export function nodeName(nodes: ReadonlyMap<string, BuildNode> | null, id: string): string {
  const n = nodes?.get(id);
  if (!n) return 'a thing';
  if (n.placeName) return n.placeName;
  if (n.parent === null) return 'the world';
  const k = shortKind(n.kind);
  return k === 'ground' ? 'the ground' : `the ${k}`;
}

const things = (n: number) => (n === 1 ? 'a thing' : `${n} things`);
const listed = (names: string[]) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

/** What an edit did, in the panel's words: "Placed 2 things in the cottage; moved the park bench". A place's row names
 *  the parent it was placed in, one row a thing; a removed thing is gone from the stream, so it is counted. */
export function editWords(e: Edit, nodes: ReadonlyMap<string, BuildNode> | null): string {
  const of = (k: Kind) => e.rows.filter((r) => r.kind === k).map((r) => r.node);
  if (of('souls:undone').length) return 'Undid an edit';
  if (of('souls:redone').length) return 'Redid an edit';
  const unique = (ids: string[]) => [...new Set(ids.map((id) => nodeName(nodes, id)))];
  const parts: string[] = [];
  const placed = of('souls:placed');
  if (placed.length) {
    const where = unique(placed);
    const into = where.length !== 1 ? '' : where[0] === 'the ground' ? ' on the ground' : ` in ${where[0]}`;
    parts.push(`placed ${things(placed.length)}${into}`);
  }
  const moved = unique(of('souls:moved')), changed = unique(of('souls:changed')), removed = of('souls:removed');
  if (moved.length) parts.push(`moved ${listed(moved)}`);
  if (changed.length) parts.push(`changed ${listed(changed)}`);
  if (removed.length) parts.push(`removed ${things(new Set(removed).size)}`);
  const text = parts.join('; ') || 'edited';
  return text[0]!.toUpperCase() + text.slice(1);
}

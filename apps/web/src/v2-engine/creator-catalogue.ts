// #5006 rows 7 and 9: Build's whole catalogue and its turn. Place offered only the kinds already standing in the world
// (7 of the 499 a world pins); it now offers every kind the world pins that a creator may place on the open ground, and
// searches them as the creator's agent's `find` does (v2/client/src/creator/catalog.mjs, its words, not its scores).
//
// The kinds a world pins are its stream's header's (field 6, `ns:name@hash`, the full names a place must name; the
// world refuses any other `edit.kind-unknown`): the page's reader reads the header at `../../../headers/<hash>` of the
// stream (creator-build.ts `watchHeader` notes where). Which of them are things, and the words each is searched by, are
// its entry's (`GET /v2/entries` beside the gateway's socket, the creator's token, as a paired client fetches them):
// `owner` "thing" is placed, a place, a body or an activity is not; its name, card, category and synonyms are searched.
// A pinned kind with no entry (an imported building) is a thing unless its name is a frame's, a body's or an activity's.
import type { Turn } from './creator-socket.ts';

/** A kind Build offers: its full name, what the panel calls it, and the words it is found by. */
export type CatalogueKind = { kind: string; name: string; card: string; words: string[] };
type Json = Record<string, unknown>;

const plain = (k: string) => k.split('@')[0]!;
/** What the panel calls a kind: `eden:park_bench@…` is "park bench". */
const nameOf = (k: string) => (plain(k).split(':').pop() ?? k).replace(/[_-]/g, ' ');
/** Names no creator places on the ground: the engine's own, frames, bodies and activities. */
const NOT_PLACED = /^souls:|:(ground|room|floor|place|extent|world|kind|humanoid|body)$|_activity$/;
const words = (s: unknown) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** catalog.mjs `singular`: benches is bench, cherries is cherry. */
const singular = (w: string) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 4 && /(ches|shes|xes|ses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/** The full kind names a stream header pins (its field 6), from its decoded map; empty when it names none. */
export function headerKinds(header: unknown): string[] {
  const list = header instanceof Map ? header.get(6) : null;
  return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && k.includes('@')) : [];
}

/** The kinds a creator may place, from the pinned full names and the world's entries (null: none fetched), with the
 *  kinds already standing in the world (`extra`, creator-build.ts `buildKinds`: a creator's own kinds among them), by
 *  name. */
export function catalogueOf(pinned: readonly string[], entries: readonly unknown[] | null, extra: readonly string[] = []): CatalogueKind[] {
  const byPlain = new Map<string, Json>();
  for (const e of entries ?? []) { const o = obj(e); if (o?.format === 'souls-entry/1' && typeof o.kind === 'string') byPlain.set(o.kind, o); }
  const out = new Map<string, CatalogueKind>();
  for (const kind of [...pinned, ...extra]) {
    const p = plain(kind), e = byPlain.get(p);
    if (out.has(kind) || (e ? e.owner !== 'thing' : NOT_PLACED.test(p) && !extra.includes(kind))) continue;
    const text = obj(e?.text) ?? {}, card = obj(e?.card) ?? {};
    const said = (key: unknown) => (typeof key === 'string' ? (typeof text[key] === 'string' ? text[key] as string : key) : '');
    const synonyms = Array.isArray(card.synonyms) ? card.synonyms.map(said) : [];
    const name = nameOf(kind);
    out.set(kind, { kind, name, card: said(card.text), words: [...new Set([...words(p.split(':').pop()), ...words(synonyms.join(' ')), ...words(said(card.category)), ...words(said(card.text))])] });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

/** The kinds that match `q`, best first: every word (or its singular) is in the kind's name, its synonyms, category or
 *  card; a name match ranks over the rest, a whole word over a part of one, a shorter name first. An empty `q` is
 *  every kind by name. */
export function searchKinds(list: readonly CatalogueKind[], q: string): CatalogueKind[] {
  const qw = words(q);
  if (!qw.length) return [...list];
  const scored: [CatalogueKind, number][] = [];
  for (const k of list) {
    const name = words(k.name);
    let score = 0;
    for (const w of qw) {
      const s = singular(w);
      const best = name.includes(w) || name.includes(s) ? 100 : name.some((n) => n.startsWith(s)) ? 60
        : k.words.includes(w) || k.words.includes(s) ? 20 : k.words.some((n) => n.startsWith(s)) ? 8 : 0;
      if (!best) { score = 0; break; }
      score += best;
    }
    if (score) scored.push([k, score]);
  }
  return scored.sort((a, b) => b[1] - a[1] || a[0].name.length - b[0].name.length || a[0].name.localeCompare(b[0].name)).map(([k]) => k);
}

// ---- the turn ------------------------------------------------------------------------------------------------------

const UNIT = 1 << 30;
const ONE = 1n << 60n;
/** replica pose.rs `NORM_TOLERANCE`: how far a turn's squared norm may be from 2^60. */
const BAND = 1n << 32n;
const abs = (n: bigint) => (n < 0n ? -n : n);
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
/** replica pose.rs `signed` and `canonical` (rule 4): the first non-zero number positive, and among the whole multiples
 *  of one direction the one whose squared norm is nearest 2^60 (the smaller on a tie). The world reads no other form of
 *  a turn (`orientation-sign`, `orientation-not-canonical`). */
export function oneForm(q: readonly bigint[]): bigint[] {
  const first = q.find((n) => n !== 0n) ?? 0n;
  const s = first < 0n ? q.map((n) => -n) : [...q];
  let g = 0n;
  for (const c of s) { let a = g, b = abs(c); while (b !== 0n) [a, b] = [b, a % b]; g = a; }
  if (g <= 1n) return s;
  const p = s.map((c) => c / g), pp = p.reduce((t, c) => t + c * c, 0n);
  const off = (k: bigint) => abs(k * k * pp - ONE);
  const k0 = isqrt(ONE / pp);
  let best = k0 - 1n > 1n ? k0 - 1n : 1n;
  for (let k = k0; k <= k0 + 2n; k++) if (off(k) < off(best)) best = k;
  return p.map((c) => c * best);
}

/** `rot` (a stream node's turn `[w, x, y, z]`, 2^30 one) turned a further `yaw` radians about its parent's +y
 *  (counter-clockwise seen from above), in the one form the world reads. */
export function turned(rot: readonly number[], yaw: number): Turn {
  const [w2, x2, y2, z2] = rot.map((v) => v / UNIT) as [number, number, number, number];
  const w1 = Math.cos(yaw / 2), y1 = Math.sin(yaw / 2);
  // (w1 + y1 j) ⊗ (w2 + x2 i + y2 j + z2 k)
  const q = [w1 * w2 - y1 * y2, w1 * x2 + y1 * z2, w1 * y2 + y1 * w2, w1 * z2 - y1 * x2];
  const n = Math.hypot(...q) || 1;
  const r = q.map((v) => BigInt(Math.round((v / n) * UNIT)));
  if (abs(r.reduce((t, c) => t + c * c, 0n) - ONE) > BAND) throw new Error('the turn left the unit band');
  return oneForm(r).map(Number) as Turn;
}

// ---- loading -------------------------------------------------------------------------------------------------------

type Cbor = { decode(b: Uint8Array, o: { useMaps: true }): unknown };
/** The pinned kinds from the header at `url` (public, as the reader fetches it); empty when it cannot be read. */
export async function pinnedKinds(url: string | null, get: typeof fetch = fetch, cbor: () => Promise<Cbor> = () => import('cborg') as Promise<Cbor>): Promise<string[]> {
  if (!url) return [];
  try {
    const r = await get(url);
    if (!r.ok) return [];
    return headerKinds((await cbor()).decode(new Uint8Array(await r.arrayBuffer()), { useMaps: true }));
  } catch { return []; }
}

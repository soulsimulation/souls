// #4535: an open page on a v2 world reloads when the stream moves to a format its bundle cannot read. The old socket's
// rule (useSouls `staleBundle`, #2368) runs on a welcome a v2 page never reads, so the stream itself says its format:
// a generation's baseline is `{1: format, 2: header hash, 3: projection, 4: cursor, ...}` (replica::stream::public,
// `FORMAT`), and the reader's worker reads field 1 before it plays the baseline. A release whose stream an older page
// cannot read raises that number; one that only adds what an older page ignores keeps it, and open pages run on.

/** The baseline formats this bundle reads. A page released ahead of a new format lists both. */
export const STREAM_FORMATS: readonly number[] = [1];
/** How long the notice shows before the reload, and the least time between two reloads for one format (a page whose
 *  new bundle is not served yet tries again a minute later, never in a loop). */
export const RELOAD_NOTICE_MS = 1_500;
export const RELOAD_AGAIN_MS = 60_000;
const KEY = 'souls.v2.format-reload';

/** A baseline's format, from its first bytes (canonical CBOR, keys in order, so field 1 comes first: `a4 01 01 ...`),
 *  or null when they name none. The whole file or its head (a ranged fetch) both do. */
export function formatOf(b: Uint8Array): number | null {
  const n = b[0] ?? 0;
  if (n >> 5 !== 5 || b[n < 0xb8 ? 1 : 2] !== 1) return null; // a map, whose first key is 1
  const i = n < 0xb8 ? 2 : 3, v = b[i] ?? 0xff;
  if (v < 24) return v;
  if (v === 24 && b.length > i + 1) return b[i + 1];
  if (v === 25 && b.length > i + 2) return (b[i + 1] << 8) | b[i + 2];
  return null;
}
/** The format when this bundle cannot read it, else null (one it reads, or none named). */
export const unreadFormat = (b: Uint8Array): number | null => { const f = formatOf(b); return f !== null && !STREAM_FORMATS.includes(f) ? f : null; };

type Store = Pick<Storage, 'getItem' | 'setItem'>;
/** Reload the page for a stream format it cannot read, after the notice, unless it reloaded for the same format less
 *  than a minute ago (a session's own note). Without session storage it never reloads: no loop it cannot see. */
export function reloadForFormat(format: number, o: { store?: Store; reload?: () => void; later?: (f: () => void, ms: number) => unknown; now?: number } = {}): boolean {
  const now = o.now ?? Date.now();
  try {
    const store = o.store ?? sessionStorage;
    const last = JSON.parse(store.getItem(KEY) ?? 'null') as { format?: number; at?: number } | null;
    if (last?.format === format && now - (last.at ?? 0) < RELOAD_AGAIN_MS) return false;
    store.setItem(KEY, JSON.stringify({ format, at: now }));
  } catch { return false; }
  (o.later ?? setTimeout)(o.reload ?? (() => location.reload()), RELOAD_NOTICE_MS);
  return true;
}

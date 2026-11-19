// What the record says happened that could be heard (V21, #2765), read in the page's workers from the bytes they
// already fetch: a live part's file (V1's numbered parts, packed by replica's `stream/lz.rs`) or a history bundle (V4,
// inflated). Each entry gives its world time, and each change of a field or named event in it one row. Nothing here
// knows which of these sound: that is `plan.ts`. The live and the replayed record give the same rows for the same
// entries, so a sound is placed in time the same way in both.
import { decode } from 'cborg';

/** One thing in the record that may be heard: world time µs, the node, and a field set (`field`, `to`) or a named
 *  event (`name`). */
export type Happened = { at: number; node: string; field?: number; to?: number; name?: string };

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** An id as the page keys nodes (`<scope hex>.<counter>`), as the workers' `key`. */
const key = (id: unknown) => `${hex((id as [Uint8Array, number])[0])}.${num((id as [Uint8Array, number])[1])}`;

/** Unpacks replica's `stream/lz.rs` format: varint(raw length), then runs of varint(literals) literals varint(match
 *  length - 3) varint(offset), a match code of 0 ending it. Refuses what does not fit, as the Rust does. */
export function unpack(packed: Uint8Array): Uint8Array {
  let at = 0;
  const get = () => {
    let n = 0, mul = 1;
    for (;;) {
      if (at >= packed.length || mul > 2 ** 49) throw new Error('stream-packing: a length runs past the end');
      const b = packed[at++];
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 128;
    }
  };
  const size = get();
  if (size > 64 << 20) throw new Error('stream-packing: the unpacked size is over the most');
  const out = new Uint8Array(size);
  let w = 0;
  for (;;) {
    const n = get();
    if (at + n > packed.length || w + n > size) throw new Error('stream-packing: literals run past the end');
    out.set(packed.subarray(at, at + n), w);
    (w += n), (at += n);
    const code = get();
    if (code === 0) break;
    const len = code + 3, offset = get();
    if (offset === 0 || offset > w || w + len > size) throw new Error('stream-packing: a match points outside');
    for (let j = 0; j < len; j++, w++) out[w] = out[w - offset];
  }
  if (at !== packed.length || w !== size) throw new Error('stream-packing: the packed bytes do not end where they say');
  return out;
}

/** The rows of a list of T6 entries (`{2: at, 6: node, 7: changes, 8: events}`): each set of a field (change type 4)
 *  and each named event, at its entry's time. */
export function happenedIn(entries: unknown[]): Happened[] {
  const out: Happened[] = [];
  for (const e of entries as Map<number, unknown>[]) {
    if (!(e instanceof Map) || !e.has(2)) continue;
    const at = num(e.get(2));
    for (const c of (e.get(7) as Map<number, unknown>[] | undefined) ?? []) {
      if (num(c.get(1)) !== 4) continue;
      const to = c.get(4);
      out.push({ at, node: key(c.get(2)), field: num(c.get(3)), to: typeof to === 'number' || typeof to === 'bigint' ? num(to) : typeof to === 'boolean' ? Number(to) : NaN });
    }
    if (e.has(6)) for (const ev of (e.get(8) as Map<number, unknown>[] | undefined) ?? []) out.push({ at, node: key(e.get(6)), name: String(ev.get(1)) });
  }
  return out;
}

/** The rows of one live part's file bytes. */
export function happenedInPart(file: Uint8Array): Happened[] {
  const sp = decode(file, { useMaps: true }) as Map<number, unknown>;
  const part = decode(unpack(sp.get(6) as Uint8Array), { useMaps: true }) as Map<number, unknown>;
  return happenedIn((part.get(2) as unknown[]) ?? []);
}

/** The rows of one inflated history bundle (`{5: snapshot, 6: view}`, the view's records at 8), all of them, before
 *  the moment sought too: a sound that started before it is heard part-way. */
export function happenedInBundle(body: Uint8Array): Happened[] {
  const b = decode(body, { useMaps: true }) as Map<number, unknown>;
  const view = b.get(6);
  return view instanceof Map ? happenedIn((view.get(8) as unknown[]) ?? []) : [];
}

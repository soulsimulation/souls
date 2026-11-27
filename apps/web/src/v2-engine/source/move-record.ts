import type { MoveRec } from './source.ts';

const num = (v: unknown): number => typeof v === 'bigint' ? Number(v) : v as number;
type IdValue = [Uint8Array, number];
const key = (id: IdValue) => `${Array.from(id[0], x => x.toString(16).padStart(2, '0')).join('')}.${num(id[1])}`;
const text = (v: unknown) => v instanceof Uint8Array ? new TextDecoder().decode(v) : v;

/** Native MoveRecord fields, including field9's authoritative end. Both start and release are form-move events. */
export function moveRec(m: Map<number, unknown>, run?: unknown): MoveRec {
  const ends = (m.get(8) as unknown[]).map(num), name = text(m.get(2)), start = num(m.get(7));
  if (typeof name !== 'string' || !ends.length || !Number.isFinite(start)) throw new Error('not a move record');
  const rec: MoveRec = { ...(run === undefined ? {} : { run: typeof run === 'number' || typeof run === 'bigint' ? String(run) : key(run as IdValue) }),
    body: key(m.get(1) as IdValue), name, start, ends, target: m.has(5) ? key(m.get(5) as IdValue) : null };
  if (m.has(4)) {
    const limbs = m.get(4);
    if (!Array.isArray(limbs)) throw new Error('not a move record');
    rec.limbs = limbs.map(v => {
      const name = text(v);
      if (typeof name !== 'string' || !name.length) throw new Error('not a move record');
      return name;
    });
  }
  if (m.has(6)) {
    const contact = text(m.get(6));
    if (typeof contact !== 'string' || !contact.length) throw new Error('not a move record');
    rec.contact = contact;
  }
  if (m.has(9)) {
    const e = m.get(9);
    if (!(e instanceof Map)) throw new Error('not a move end');
    const at = num(e.get(1)), how = text(e.get(2));
    if (!Number.isFinite(at) || at < start || typeof how !== 'string' || !how.length) throw new Error('not a move end');
    rec.ended = { at, how };
  }
  return rec;
}

// A slot of another thing as an act's argument (0.135 E14b): `seat=<bench id>/left` (or `/1`) for a lecture's
// attendee on a bench of its hall. It is checked as R2's `{node, slot}`, the slot by its name, and goes on the wire
// as `{node, slot: number}`, which `wireIntent` sends as `[id, number]`, the slot numbered 1, 2, ... in that thing's
// own entry.

const OTHER = /^([0-9a-f]{32}-\d+)\/([A-Za-z0-9_]+)$/;

/** The slot names of node `id`'s entry, in its order, from the held kinds and the copy's rows. */
const namesOf = (id, kinds, rows) => Object.keys(kinds[rows.get(id)?.entry ?? rows.get(id)?.kind]?.slots ?? {});

/**
 * `value` read as a slot of another thing: `{node, slot}` with the slot by name where the copy holds that thing's
 * kind (by number where it does not), or null for any other value. Throws `act-slot-unknown` for a slot its entry
 * has not, or a name the copy cannot read.
 */
export function otherSlot(value, kinds, rows) {
  const m = OTHER.exec(String(value));
  if (!m) return null;
  const names = namesOf(m[1], kinds, rows);
  const slot = /^\d+$/.test(m[2]) ? names[Number(m[2]) - 1] ?? Number(m[2]) : m[2];
  if (typeof slot === 'string' && !names.includes(slot)) {
    const why = names.length ? `${m[1]} has no slot ${slot}: ${names.join(', ')}` : `${m[1]}'s slots are not in your copy: name the slot by its number`;
    throw Object.assign(new Error(why), { code: 'act-slot-unknown' });
  }
  if (typeof slot === 'number' && slot < 1) throw Object.assign(new Error('a slot is numbered from 1'), { code: 'act-slot-unknown' });
  return { node: m[1], slot };
}

/** A form's argument pairs as they go on the wire: each slot of another thing by its slot's number. */
export function slotsOf(pairs, kinds, rows) {
  return pairs.map(([n, v]) => {
    if (!v || typeof v !== 'object' || typeof v.node !== 'string') return [n, v];
    return [n, { node: v.node, slot: typeof v.slot === 'number' ? v.slot : namesOf(v.node, kinds, rows).indexOf(v.slot) + 1 }];
  });
}

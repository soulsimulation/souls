// D8 (0.132): a seated or lying Soul can stand. A seat's or a bed's own form takes a body into its slot without
// writing the body's posture (field 28), so the world refuses the body's `stand` with `field_differs` (its need is a
// posture that is not `stand`). The client sends that stand as the holding thing's rise, which the world runs.

const STAND = /(^|:)stand$/;

/**
 * `candidates` with each stand on my own body (or a bare `stand`) replaced by `<ns>:rise` on the thing holding it, when
 * that thing's body slots give a posture other than standing; otherwise unchanged. `rows` are the copy's rows by id,
 * `kinds` the held entries by kind, `me` this daemon's Soul (its body is the row with `soul: me`, or `me` itself).
 */
export function risesFromSeat(candidates, { rows, kinds, me, ns }) {
  if (!candidates.some((c) => STAND.test(c.verb ?? ''))) return candidates;
  const body = [...rows.values()].find((r) => r.id === me || r.soul === me);
  const seat = body?.parent ? rows.get(body.parent) : null;
  const slots = Object.values(kinds[seat?.entry ?? seat?.kind]?.slots ?? {});
  if (!slots.some((t) => t?.admits === 'body' && typeof t.posture === 'string' && t.posture !== 'stand')) return candidates;
  return candidates.map((c) => (STAND.test(c.verb ?? '') && (c.this === undefined || c.this === body.id) ? { verb: `${ns}:rise`, this: seat.id } : c));
}

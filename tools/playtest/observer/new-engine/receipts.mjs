// The gateway's answers to each seat's intents (0.135 P1): read from the seat's daemon with `souls.mjs events --since`,
// which hands the events after a cursor without taking them from the seat's own `wait`. An answer event is the
// gateway's word on one intent (`{kind: 'answer', sequence, answer, reason?}`, C4's kinds below). This replaces the old
// world's public receipts list (`/v1/edge/public/souls/<id>`): on the new engine a Soul's receipts reach only its own
// client.

/** C4's answer kinds (v2/client/served/e2e/world.test.mjs). */
export const ANSWERS = { 1: 'receipt', 2: 'refused', 3: 'accepted', 4: 'resolved', 5: 'unread' };

/** The answer events of one `events` reply, as receipts: [{n, sequence, outcome, reason}] */
export const answersOf = (reply) => (reply?.events ?? []).filter((e) => e?.kind === 'answer')
  .map((e) => ({ n: e.n ?? null, sequence: e.sequence ?? null, outcome: ANSWERS[e.answer] ?? `answer-${e.answer}`, reason: e.reason ?? null }));

/** The final outcome of each intent: the last answer by sequence, an accepted one superseded by its receipt. */
export function finalBySequence(receipts) {
  const out = new Map();
  for (const r of receipts) if (r.sequence != null) out.set(r.sequence, r);
  return out;
}

/** A reader per seat: `read()` adds the answers since the last read and returns every one seen so far. */
export function receiptReader(seat) {
  let cursor = 0;
  const seen = [];
  return {
    seen,
    async read() {
      const reply = await seat.events(cursor);
      if (reply?.ok && Number.isFinite(reply.cursor)) cursor = reply.cursor;
      seen.push(...answersOf(reply));
      return seen;
    },
  };
}

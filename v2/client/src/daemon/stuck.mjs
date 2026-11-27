// A walk that got nowhere, as the world names it. Two ways end one today: C21's stall watch (`walk.blocked`, a form's
// walk) and the never-stuck ladder (0.133 N1: a gateway walk's order ends `goal-unreachable` at 15 s). The ladder also
// writes an entry on the walker, `souls:order-ended {1: walker, 2: order, 3: name, 4: what it waited for}` (worldd's
// `unstick.rs`), which the receipt's refusal does not carry: this reads that entry so `receipt` and `act --wait` can
// say how far the walk got, and keeps R1b's suggestion off a stuck walk (every offer of its target needs the same way
// there).
import { decode } from '../brief/copy.mjs';

/** The refusals that mean the body could not get there. */
export const STUCK = new Set(['walk.blocked', 'goal-unreachable']);
/** The ladder's entry event. */
export const ORDER_ENDED = 'souls:order-ended';

/** A text field as the daemon's entry JSON gives it: a name as itself, bytes as the hex of their encoding. */
export function textOf(v) {
  if (typeof v !== 'string') return null;
  if (!/^[0-9a-f]+$/.test(v) || v.length % 2) return v;
  try {
    const b = decode(Buffer.from(v, 'hex'));
    return b instanceof Uint8Array ? new TextDecoder().decode(b) : typeof b === 'string' ? b : v;
  } catch {
    return v;
  }
}

/** An order of `mine` (my Soul's or my body's id) ended by the world's ladder, from one of an entry's events: `{ name,
 *  why }`; null for any other event. */
export function stuckOf(ev, mine) {
  if (ev?.name !== ORDER_ENDED || !mine.includes(ev.fields?.[1])) return null;
  const name = textOf(ev.fields[3]);
  return name ? { name, why: textOf(ev.fields[4]) } : null;
}

/** What receipt `r` (refused) says about a stuck walk: what the newest matching ended order seen since it was sent
 *  waited for, from `ended` (`{ name, why, seenAt }`, oldest first). Null when it is not a stuck walk's refusal. */
export function whyOf(r, ended) {
  const last = r?.answers?.at(-1);
  if (last?.answer !== 'refused' || !STUCK.has(last.reason)) return null;
  const sent = Date.parse(r.sentAt ?? '') || 0;
  const e = [...ended].reverse().find((x) => x.name === last.reason && x.seenAt >= sent);
  return e?.why ?? null;
}

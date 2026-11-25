// Gene 2026-10-20c: once an approved Soul's body is in the world, the approval card closes and the camera follows the new
// Soul. The card lives in the god panel (inside the viewer); the camera belongs to the Shell's viewer handle. This event
// carries the Soul id across; the Shell follows it the way Explore -> a Soul does (select it, camera mode 'follow').
export const FOLLOW_SOUL_EVENT = 'sim:follow-soul';
/** How long the Shell keeps trying while the new Soul has not reached this window's picture yet. */
export const FOLLOW_SOUL_WAIT_MS = 60_000;

export const isSoulId = (id: unknown): id is string => typeof id === 'string' && /^s_[A-Za-z0-9_-]+$/.test(id);

/** `approved`: this window just approved the Soul, so the Shell re-reads Me for it (a reconnect). Every other follow (a
 *  chip, Explore, the card's Follow) is a camera move only: #2280 measured each one reconnecting the page's socket. */
export function requestFollowSoul(soulId: string, target: Pick<EventTarget, 'dispatchEvent'> | null = typeof window === 'undefined' ? null : window, approved = false): boolean {
  if (!isSoulId(soulId) || !target) return false;
  target.dispatchEvent(new CustomEvent(FOLLOW_SOUL_EVENT, { detail: { soulId, approved } }));
  return true;
}

export function onFollowSoulRequest(cb: (soulId: string, approved: boolean) => void, target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const listener = (e: Event) => { const d = (e as CustomEvent<{ soulId?: unknown; approved?: unknown }>).detail; if (isSoulId(d?.soulId)) cb(d.soulId, d.approved === true); };
  target.addEventListener(FOLLOW_SOUL_EVENT, listener);
  return () => target.removeEventListener(FOLLOW_SOUL_EVENT, listener);
}

/** Whether a Soul's body is in this window's picture now: the approval card asks it (V2PairDialog.tsx, the Soul is
 *  arriving…) and the Shell, which holds the world's copy, answers. False when nothing answers. */
export const SOUL_PRESENT_EVENT = 'sim:soul-present';
export function soulPresent(soulId: string, target: Pick<EventTarget, 'dispatchEvent'> | null = typeof window === 'undefined' ? null : window): boolean {
  let seen = false;
  target?.dispatchEvent(new CustomEvent(SOUL_PRESENT_EVENT, { detail: { soulId, answer: (v: boolean) => { seen = v; } } }));
  return seen;
}
export function onSoulPresentQuery(present: (soulId: string) => boolean, target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const listener = (e: Event) => { const d = (e as CustomEvent<{ soulId?: unknown; answer?: unknown }>).detail; if (isSoulId(d?.soulId) && typeof d.answer === 'function') d.answer(present(d.soulId)); };
  target.addEventListener(SOUL_PRESENT_EVENT, listener);
  return () => target.removeEventListener(SOUL_PRESENT_EVENT, listener);
}

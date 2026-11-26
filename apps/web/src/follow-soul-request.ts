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

/** How the camera is on `soulId` as the camera chip says it (ViewerFrame's `kind`), so the Soul card's Follow button and
 *  the chip agree (first day, 25 Nov: right after arrival, while the camera flew to the new Soul, the chip said
 *  "Following" and the card offered "Follow"): `following` while it follows or flies to it; `held` while the viewer has
 *  pulled out of that follow (the chip and its hint offer "Follow again"); else null. */
export function cameraOnSoul(state: { cameraMode?: string; flyingTo?: string | null; followHeld?: boolean; selection?: { soulId?: string | null } } | null | undefined, soulId: string | null): 'following' | 'held' | null {
  if (!state || !soulId) return null;
  if (state.flyingTo) return state.flyingTo === soulId ? 'following' : null;
  if (state.cameraMode !== 'follow' || state.selection?.soulId !== soulId) return null;
  return state.followHeld ? 'held' : 'following';
}

export function onFollowSoulRequest(cb: (soulId: string, approved: boolean) => void, target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const listener = (e: Event) => { const d = (e as CustomEvent<{ soulId?: unknown; approved?: unknown }>).detail; if (isSoulId(d?.soulId)) cb(d.soulId, d.approved === true); };
  target.addEventListener(FOLLOW_SOUL_EVENT, listener);
  return () => target.removeEventListener(FOLLOW_SOUL_EVENT, listener);
}

/** 0.137 (26 Nov): a #soul link, or the owner's Soul after pairing, keeps the camera on that Soul until the viewer chooses
 *  otherwise. On soul.game the camera went back to the Broadcast tour about 20 s after a #soul link opened, while the card
 *  stayed open. The Shell holds the Soul (useFollowHold) and puts the camera back on it whenever it is on Broadcast that
 *  the viewer did not ask for (`requestBroadcast`: the camera pill and its menu). */
export const BROADCAST_CHOSEN_EVENT = 'sim:broadcast-chosen';
export function requestBroadcast(target: Pick<EventTarget, 'dispatchEvent'> | null = typeof window === 'undefined' ? null : window): void {
  target?.dispatchEvent(new CustomEvent(BROADCAST_CHOSEN_EVENT));
}
export function onBroadcastChosen(cb: () => void, target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): () => void {
  target.addEventListener(BROADCAST_CHOSEN_EVENT, cb);
  return () => target.removeEventListener(BROADCAST_CHOSEN_EVENT, cb);
}
/** What a held follow does with this viewer state: `keep` (on it, flying to it, or nothing to decide), `refollow` (the
 *  camera is on Broadcast and the viewer did not choose it), `release` (the viewer chose another Soul or their own camera). */
export function followHoldStep(soulId: string, state: { cameraMode?: string; flyingTo?: string | null; presentation?: string; inputOwned?: boolean; selection?: { soulId?: string | null } } | null | undefined): 'keep' | 'refollow' | 'release' {
  if (!state) return 'keep';
  if (state.flyingTo) return state.flyingTo === soulId ? 'keep' : 'release';
  const chosen = state.selection?.soulId;
  if (chosen && chosen !== soulId) return 'release';
  if (state.cameraMode === 'manual') return 'release';
  if (state.cameraMode === 'broadcast' && state.presentation !== 'history' && !state.inputOwned) return 'refollow';
  return 'keep';
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

/** #2280: the navbar's own Souls across a reconnect. A new socket retires private authority (Me goes to null) until its
 * welcome, so the navbar showed no Souls for a moment on every reconnect. Until that welcome, the navbar keeps the last
 * list the same signed-in identity was given, marked reconnecting; a welcome without Me or another identity drops it. Display only: chips select and follow public Souls. Ownership and the private API still come only from the
 * live Me. The list is kept for this tab (sessionStorage), so a page reload shows it too until the welcome. */
export type HeldSouls = { identity: string; souls: readonly string[] };
export type ShownSouls = { ids: readonly string[]; owner: string | null; reconnecting: boolean; held: HeldSouls | null };

/** Not signed in (or sign-in still loading, as Clerk is after a reload): who this is is unknown, so nothing is shown and
 *  the list is kept for when the same identity is back. Another identity, or a welcome without Me, drops it. */
export function shownOwnedSouls(held: HeldSouls | null, authed: boolean, identity: string | null, me: { userId: string; souls: readonly string[] } | null, awaitingWelcome: boolean): ShownSouls {
  const none = (keep: HeldSouls | null): ShownSouls => ({ ids: [], owner: null, reconnecting: false, held: keep });
  if (me) return { ids: me.souls, owner: me.userId, reconnecting: false, held: authed && identity === me.userId ? { identity, souls: [...me.souls] } : held };
  if (!authed || !identity) return none(held);
  if (held?.identity !== identity || !awaitingWelcome) return none(null);
  return { ids: held.souls, owner: held.identity, reconnecting: held.souls.length > 0, held };
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
export function readHeldSouls(key: string, store: Pick<Storage, 'getItem'> | undefined = globalThis.sessionStorage): HeldSouls | null {
  try {
    const v = JSON.parse(store?.getItem(key) ?? 'null') as unknown;
    if (!v || typeof v !== 'object') return null;
    const { identity, souls } = v as { identity?: unknown; souls?: unknown };
    if (typeof identity !== 'string' || !identity || !Array.isArray(souls)) return null;
    return { identity, souls: souls.filter((id): id is string => typeof id === 'string' && ID.test(id)).slice(0, 100) };
  } catch { return null; }
}
export function writeHeldSouls(key: string, held: HeldSouls | null, store: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.sessionStorage) {
  try { if (held) store?.setItem(key, JSON.stringify(held)); else store?.removeItem(key); } catch { /* memory only */ }
}

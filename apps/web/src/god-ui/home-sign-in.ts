// The home page's sign-in and its one intent. "+ New world" while signed out signs in first and comes back to the
// dialog: the intent rides in the return address as `?new=1` (kept through the sign-in redirect and Clerk's satellite
// sync, which both return to the full address). "Sign in" carries no intent and lands on the plain home page. The
// intent is used once: the page reads it and takes it out of its address, so a reload does not open the dialog again.

export const NEW_WORLD_PARAM = 'new';

export type HomeSignIn = { signInUrl?: string; login(): void };

/** Start a sign-in from the home page; `newWorld` when "+ New world" started it. */
export function startHomeSignIn(session: HomeSignIn, newWorld: boolean, page: { pathname: string; search: string }, go: { assign(url: string): void; replaceAddress(url: string): void }) {
  const q = new URLSearchParams(page.search);
  if (newWorld) q.set(NEW_WORLD_PARAM, '1'); else q.delete(NEW_WORLD_PARAM);
  const search = q.toString() ? '?' + q.toString() : '';
  // a preview host signs in on the canonical site, which returns to the home page there
  if (session.signInUrl) { go.assign(session.signInUrl + (newWorld ? `?${NEW_WORLD_PARAM}=1` : '')); return; }
  // here: the address the sign-in returns to says whether the dialog opens
  go.replaceAddress(page.pathname + search);
  session.login();
}

/** The page's address on arrival: whether the dialog opens, and the address with the intent taken out (null: unchanged). */
export function takeNewWorldIntent(page: { pathname: string; search: string; hash: string }): { open: boolean; address: string | null } {
  const q = new URLSearchParams(page.search);
  if (!q.has(NEW_WORLD_PARAM)) return { open: false, address: null };
  q.delete(NEW_WORLD_PARAM);
  return { open: true, address: page.pathname + (q.toString() ? '?' + q.toString() : '') + page.hash };
}

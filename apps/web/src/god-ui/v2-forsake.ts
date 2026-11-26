// Forsake world on a world the new engine runs (#5006 rows 16 and 38). There the directory keeps who the world's creator
// is, so God Mode's Forsake asks the directory, as the held v2 creator panel did (v2/web/src/worlds/handoff.ts, archive.ts),
// over routes it already serves (directoryd worlds/list/http.rs `handoff`, `archive`):
//   POST <directory>/v1/worlds/handoff/offer  {world}          → {code, expires}: a one-use link, 7 days; a new one replaces it
//   POST <directory>/v1/worlds/handoff/cancel {world}          → {cancelled}
//   POST <directory>/v1/worlds/handoff/accept {world, code}    → {accepted}: the signed-in recipient becomes the creator
//   POST <directory>/v1/worlds/archive        {world, confirm} → 200 {archived}, or 202 {pending} while the world stops
// Signed in as those routes sign in: the provider's session token as the bearer, or on a local world `test:<name>` (a
// `dev:<name>` page sign-in, or `?as=`). Nothing here deletes: archiving stops the world and keeps all of it, and only an
// operator restores it. The recipient's account is a signed-in one, so a world is only ever handed to a signed-in person.
import { session as pageSession } from '../auth-session.ts';
import { v2MailboxPlace, v2WorldName, type MailboxPlace } from '../v2-engine/owner-mailbox.ts';

export type ForsakePlace = { directory: string; session: MailboxPlace['session'] };
export type Deps = { post?: typeof fetch; token?: () => Promise<string | null> };

/** This page's world and its directory, on a world the new engine runs; null on an old-engine world. */
export function forsakeHere(): { place: ForsakePlace; world: string } | null {
  const place = v2MailboxPlace(), world = v2WorldName();
  return place && world ? { place, world } : null;
}

/** A refusal the directory named. */
export class Refused extends Error {
  readonly refused: string;
  constructor(name: string) { super(refusalText(name)); this.refused = name; }
}

const WORDS: Record<string, string> = {
  'token-missing': 'Sign in first.',
  'session-revoked': 'Your sign-in has ended. Sign in again.',
  'not-the-creator': 'Only this world\'s creator can do that.',
  'world-missing': 'The directory does not list this world.',
  'world-archived': 'This world is archived, or being archived.',
  'archive-confirmation': 'Type the world\'s exact name to archive it.',
  'archive-handoff-pending': 'Cancel the open handoff link first.',
  'archive-world-starting': 'The world is still being made. Try again once it is running.',
  'archive-pending': 'A restore of this world is under way.',
  'archive-unavailable': 'Archiving is not available here now. Nothing was changed.',
  'handoff-unknown': 'This link is not valid: it was cancelled, replaced by a newer link, or mistyped.',
  'handoff-invalid': 'This link is not valid.',
  'handoff-used': 'This link has already been used.',
  'handoff-expired': 'This link has expired.',
  'handoff-not-for-you': 'This link is for another account.',
  'handoff-already-owner': 'You already own this world.',
  'handoff-stale': 'Whoever made this link no longer owns the world.',
  'handoff-pending': 'The handoff is still being finished. Select Accept again in a moment.',
  'world-authority-required': 'This server cannot hand worlds on. Nothing was changed.',
};
/** The plain words for a refusal's name. */
export const refusalText = (name: string): string => WORDS[name] ?? `Refused (${name}).`;

/** The bearer the directory's world routes take for this page's sign-in, or null when signed out. */
export async function worldsBearer(place: Pick<ForsakePlace, 'session'>, token: () => Promise<string | null> = () => pageSession().getToken()): Promise<string | null> {
  if ('testName' in place.session) return `test:${place.session.testName}`;
  const t = await token().catch(() => null);
  return !t ? null : t.startsWith('dev:') ? `test:${t.slice(4)}` : t;
}

async function ask(place: ForsakePlace, path: string, body: Record<string, unknown>, deps: Deps = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const bearer = await worldsBearer(place, deps.token);
  if (!bearer) throw new Error('Sign in first.');
  let r: Response;
  try {
    r = await (deps.post ?? fetch)(`${place.directory}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error('The directory did not answer. Try again: the same step is safe to repeat.'); }
  const d = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw new Refused(typeof d.refused === 'string' ? d.refused : `http-${r.status}`);
  return { status: r.status, body: d };
}

/** A one-use handoff link's code and when it expires (seconds); a new offer replaces any earlier one. */
export async function offerHandoff(place: ForsakePlace, world: string, deps?: Deps): Promise<{ code: string; expires: number }> {
  const { body } = await ask(place, '/v1/worlds/handoff/offer', { world }, deps);
  if (typeof body.code !== 'string' || typeof body.expires !== 'number') throw new Error('The directory gave no link.');
  return { code: body.code, expires: body.expires };
}
export async function cancelHandoff(place: ForsakePlace, world: string, deps?: Deps): Promise<void> { await ask(place, '/v1/worlds/handoff/cancel', { world }, deps); }
/** The signed-in recipient accepts: on success they are the world's creator. Asking again with the same code is safe. */
export async function acceptHandoff(place: ForsakePlace, world: string, code: string, deps?: Deps): Promise<void> {
  const { body } = await ask(place, '/v1/worlds/handoff/accept', { world, code }, deps);
  if (body.accepted !== true) throw new Error('The directory did not confirm the handoff. Select Accept again.');
}
/** Archive (the exact world name as confirmation): `archived`, or `pending` while the world stops. Asking again reads
 *  the same request; it never starts a second one. */
export async function archiveWorld(place: ForsakePlace, world: string, confirm: string, deps?: Deps): Promise<'archived' | 'pending'> {
  if (confirm !== world) throw new Refused('archive-confirmation');
  const { body } = await ask(place, '/v1/worlds/archive', { world, confirm }, deps);
  if (body.archived === true) return 'archived';
  if (body.pending === true) return 'pending';
  throw new Error('The directory did not confirm the archive. Select Check again.');
}

/** The link the recipient opens: this world's page with the offer in its fragment (never the query, so the code is not
 *  sent to the server or kept in its logs; the page's own query, which may carry a local `as=`, is dropped). */
export function offerLink(href: string, code: string): string {
  const u = new URL(href);
  u.search = ''; u.hash = `worldoffer/${code}`;
  return u.href;
}

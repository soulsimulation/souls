import { browserSession, localTestSignIn, sessionRequest, type BrowserSession } from '../source/signin.ts';

const worldName = (s: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s);
const codeText = (s: string): boolean => /^[A-Za-z0-9_-]{32}$/.test(s);
export type HandoffOffer = { world: string; code: string };

/** A share code stays in the fragment; no token-bearing destination or raw code is sent as a URL query. */
export function handoffLink(directory: string, offer: HandoffOffer): string {
  if (!worldName(offer.world) || !codeText(offer.code)) throw Error('Invalid handoff offer.');
  const url = new URL('/src/worlds/', directory);
  url.hash = `handoff/${offer.world}/${offer.code}`;
  return url.href;
}

export function readHandoff(hash: string): HandoffOffer | null {
  const match = /^#handoff\/([^/]+)\/([^/]+)$/.exec(hash);
  return match && worldName(match[1]) && codeText(match[2]) ? { world: match[1], code: match[2] } : null;
}

/** One explicit action using a fresh provider token. Identity changes discard any late private result. */
export async function handoffRequest(directory: string, action: 'offer' | 'cancel' | 'accept', world: string,
  identity: BrowserSession, extra: Record<string, unknown> = {}, post: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (!worldName(world)) throw Error('Invalid world.');
  let changed = false;
  const stop = identity.subscribeIdentity?.(() => { changed = true; });
  try {
    const request = await sessionRequest(identity, 'world', { ...extra, world });
    if (changed) throw Error('Account changed. Sign in and try again.');
    const response = await post(new URL(`/v1/worlds/handoff/${action}`, directory).href,
      { ...request, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as Record<string, unknown>;
    if (changed) throw Error('Account changed. Sign in and try again.');
    if (!response.ok) throw Error(`Refused: ${String(body.refused ?? response.status)}.`);
    return body;
  } finally { stop?.(); }
}

export function creatorHandoff(container: HTMLElement, world: string | null, directory: string, testName: () => string): void {
  const form = container.querySelector<HTMLFormElement>('form')!;
  const recipient = container.querySelector<HTMLInputElement>('input')!;
  const cancel = container.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const status = container.querySelector<HTMLElement>('[role=status]')!;
  let busy = false;
  const action = async (kind: 'offer' | 'cancel') => {
    if (busy || !world) return;
    busy = true;
    for (const button of container.querySelectorAll('button')) button.disabled = true;
    status.textContent = kind === 'offer' ? 'Creating an offer…' : 'Cancelling the offer…';
    try {
      const identity = await browserSession(testName());
      if (!identity) { status.textContent = 'Finish signing in, then select the action again.'; return; }
      const body = await handoffRequest(directory, kind, world, identity, kind === 'offer' ? { to: recipient.value.trim() || undefined } : {});
      status.replaceChildren();
      if (kind === 'offer') {
        if (typeof body.code !== 'string') throw Error('The directory did not return an offer.');
        const link = document.createElement('a'); link.href = handoffLink(directory, { world, code: body.code });
        link.textContent = 'Copy this offer link for the recipient';
        status.append(link, document.createTextNode(' · expires in seven days; only acceptance gives the world away.'));
      } else status.textContent = 'Offer cancelled.';
    } catch (error) { status.textContent = (error as Error).message; }
    finally { busy = false; for (const button of container.querySelectorAll('button')) button.disabled = !world; }
  };
  form.addEventListener('submit', event => { event.preventDefault(); void action('offer'); });
  cancel.addEventListener('click', () => void action('cancel'));
  if (!world) { status.textContent = 'Open an installed world to offer it.'; for (const b of container.querySelectorAll('button')) b.disabled = true; }
}

/** Acceptance is an ordinary signed-in explicit click on the existing worlds page. */
export function recipientHandoff(): void {
  const offer = readHandoff(location.hash);
  if (!offer) return;
  const section = document.getElementById('handoff-accept')!; section.hidden = false;
  const form = section.querySelector<HTMLFormElement>('form')!, status = section.querySelector<HTMLElement>('[role=status]')!;
  const who = section.querySelector<HTMLInputElement>('input')!, button = section.querySelector<HTMLButtonElement>('button')!;
  who.parentElement!.hidden = !localTestSignIn(location.href);
  section.querySelector('h2')!.textContent = `Accept ${offer.world}`;
  status.textContent = 'Accepting gives you this world and revokes its previous creator’s agents. Souls and world content stay as they are.';
  let busy = false;
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; button.disabled = true;
    try {
      const identity = await browserSession(who.value);
      if (!identity) { status.textContent = 'Finish signing in, then select Accept again.'; return; }
      await handoffRequest(location.origin, 'accept', offer.world, identity, { code: offer.code });
      status.replaceChildren(); const link = document.createElement('a'); link.href = `/w/${offer.world}/src/panel/`; link.textContent = 'Open your creator panel';
      status.append(document.createTextNode('World accepted. '), link); form.hidden = true;
      history.replaceState(null, '', location.pathname + location.search);
    } catch (error) { status.textContent = (error as Error).message; }
    finally { busy = false; button.disabled = false; }
  });
}

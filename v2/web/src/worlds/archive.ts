import { browserSession, sessionRequest, type BrowserSession } from '../source/signin.ts';

/** One confirmed creator action; a late answer after account change is never shown as this person's result. */
export async function archiveRequest(directory: string, world: string, confirm: string, identity: BrowserSession,
  post: typeof fetch = fetch): Promise<{ archived: boolean; pending: boolean }> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(world) || confirm !== world) throw Error('Type the exact world name to archive.');
  let changed = false;
  const stop = identity.subscribeIdentity?.(() => { changed = true; });
  try {
    const init = await sessionRequest(identity, 'world', { world, confirm });
    if (changed) throw Error('Account changed. Sign in and try again.');
    const response = await post(new URL('/v1/worlds/archive', directory), { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { archived?: boolean; pending?: boolean; refused?: string };
    if (changed) throw Error('Account changed. Sign in and try again.');
    if (!response.ok) throw Error(`Refused: ${body.refused ?? response.status}.`);
    return { archived: body.archived === true, pending: body.pending === true };
  } finally { stop?.(); }
}

export function creatorArchive(container: HTMLElement, world: string | null, directory: string, testName: () => string,
  signIn: typeof browserSession = browserSession, post: typeof fetch = fetch): () => void {
  const form = container.querySelector<HTMLFormElement>('form')!, confirm = container.querySelector<HTMLInputElement>('input')!;
  const status = container.querySelector<HTMLElement>('[role=status]')!, button = container.querySelector<HTMLButtonElement>('button')!;
  const name = container.querySelector<HTMLElement>('[data-world]')!; name.textContent = world ?? 'this world';
  let busy = false, generation = 0, stopIdentity: (() => void) | null = null;
  const reset = () => {
    ++generation; stopIdentity?.(); stopIdentity = null; busy = false;
    delete container.dataset.operation; status.textContent = ''; confirm.value = ''; form.hidden = false;
    button.textContent = 'Archive world'; button.disabled = !world;
  };
  if (!world) { button.disabled = true; return reset; }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; button.disabled = true;
    const attempt = generation;
    try {
      const identity = await signIn(testName());
      if (attempt !== generation) return;
      if (!identity) { reset(); status.textContent = 'Finish signing in, then select Archive again.'; return; }
      stopIdentity?.(); stopIdentity = null;
      const unsubscribe = identity.subscribeIdentity?.(reset);
      if (attempt !== generation) { unsubscribe?.(); return; }
      stopIdentity = unsubscribe ?? null;
      const result = await archiveRequest(directory, world, confirm.value, identity, post);
      if (attempt !== generation) return;
      if (!result.pending && !result.archived) throw Error('Archive response did not confirm an operation.');
      container.dataset.operation = result.archived ? 'archived' : 'pending';
      status.textContent = result.archived ? 'World archived. Its address and data are kept; an operator can restore it.'
        : 'Archiving this world. Its data is kept. Select Check archive again to read the same operation.';
      button.textContent = result.archived ? 'Archived' : 'Check archive';
      if (result.archived) form.hidden = true;
    } catch (error) { if (attempt === generation) status.textContent = (error as Error).message; }
    finally { if (attempt === generation) { busy = false; button.disabled = false; } }
  });
  return reset;
}

// A world's welcome and its recent visitors (#3702), on the creator's panel: today's owner reads who has been visiting
// (`/v1/world/visitors`); here the creator also sets the words a Soul is shown when it arrives. Both are the
// directory's (`POST /v1/worlds/welcome`, `POST /v1/worlds/visitors`), signed in as the creator. Names are shown as
// text, never as markup.
import { browserSession, sessionRequest, type BrowserSession } from '../source/signin.ts';

/** One recent visitor, as the directory lists it: nothing of its owner's account or device. */
export type Visitor = { soul: string; name: string | null; arrived: number; connected: boolean };
export type Visitors = { welcome: string | null; visitors: Visitor[] };
/** The longest welcome, in characters (the directory refuses longer by name). */
export const WELCOME_MOST = 500;

async function ask<T>(directory: string, path: string, body: Record<string, unknown>, identity: BrowserSession, post: typeof fetch): Promise<T> {
  const init = await sessionRequest(identity, 'world', body);
  const response = await post(new URL(path, directory), { ...init, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  const got = await response.json() as T & { refused?: string };
  if (!response.ok || got.refused) throw Error(`Refused: ${got.refused ?? response.status}.`);
  return got;
}

/** Sets the world's welcome ('' clears it); the words as the directory kept them. */
export async function welcomeRequest(directory: string, world: string, words: string, identity: BrowserSession, post: typeof fetch = fetch): Promise<string | null> {
  if ([...words.trim()].length > WELCOME_MOST) throw Error(`At most ${WELCOME_MOST} characters.`);
  const got = await ask<{ world: { welcome?: string } }>(directory, '/v1/worlds/welcome', { world, welcome: words }, identity, post);
  return got.world.welcome ?? null;
}

/** The world's welcome and its recent visitors, newest first. */
export const visitorsRequest = (directory: string, world: string, identity: BrowserSession, post: typeof fetch = fetch) =>
  ask<Visitors>(directory, '/v1/worlds/visitors', { world }, identity, post);

/** How long ago, in words. */
export function ago(seconds: number, now: number): string {
  const s = Math.max(0, now - seconds);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}

/** One visitor's line: its name (or its grant's end), when it arrived, and whether an agent holds it now. */
export const visitorLine = (v: Visitor, now: number) =>
  `${v.name ?? `Soul ${v.soul.slice(-8)}`}, arrived ${ago(v.arrived, now)}${v.connected ? ', here now' : ''}`;

export function creatorVisitors(container: HTMLElement, world: string | null, directory: string, testName: () => string): void {
  const form = container.querySelector<HTMLFormElement>('form')!, words = container.querySelector<HTMLTextAreaElement>('textarea')!;
  const status = container.querySelector<HTMLElement>('[role=status]')!, list = container.querySelector<HTMLUListElement>('ul')!;
  const refresh = container.querySelector<HTMLButtonElement>('[data-refresh]')!;
  if (!world) { form.hidden = true; refresh.disabled = true; return; }
  words.maxLength = WELCOME_MOST;
  const show = (v: Visitors) => {
    if (document.activeElement !== words) words.value = v.welcome ?? '';
    const now = Date.now() / 1000;
    list.replaceChildren(...v.visitors.map((x) => Object.assign(document.createElement('li'), { textContent: visitorLine(x, now) })));
    if (!v.visitors.length) list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'No visitors yet.' }));
  };
  const identity = async () => {
    const id = await browserSession(testName());
    if (!id) throw Error('Finish signing in, then try again.');
    return id;
  };
  const read = async () => {
    try { show(await visitorsRequest(directory, world, await identity())); status.textContent = ''; } catch (e) { status.textContent = (e as Error).message; }
  };
  refresh.addEventListener('click', () => void read());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const kept = await welcomeRequest(directory, world, words.value, await identity());
      status.textContent = kept ? 'Welcome saved: a Soul is shown it when it arrives.' : 'Welcome cleared.';
    } catch (e) { status.textContent = (e as Error).message; }
  });
  void read();
}

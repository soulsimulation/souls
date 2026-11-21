// The first-visit welcome card and the Eden tour's controls (C2, #3674; today's VisitorWelcome and EdenTour). A
// visitor's first page shows the card once the world is drawn; dismissing it (its ×, "Look around" or starting the tour)
// is remembered in this browser, and a browser that cannot store it simply shows the card again, never an error. In
// Eden the card and a "Tour" button next to the find box start the guided camera tour; while it runs a bar names the
// stop and offers "Next" and "Leave tour". The tour moves the camera only.
import type { Stop } from './stops.ts';

export const SEEN_KEY = 'v2-welcome-seen';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** True when this browser has dismissed the card; a storage that throws or is missing counts as not dismissed. */
export function seen(store: () => Store | null | undefined): boolean {
  try {
    return store()?.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the dismissal where it can; a storage that throws is ignored. */
export function remember(store: () => Store | null | undefined): void {
  try {
    store()?.setItem(SEEN_KEY, '1');
  } catch {
    /* the card shows again next visit */
  }
}

/** The world's name for the card: an installed world's path (`/w/<name>`), the page's `world`, else Eden when the drawn
 *  world holds Eden's imported things (`eden:` kinds), else none. */
export function worldOf(path: string, params: URLSearchParams, kinds: () => Iterable<string>): string | null {
  const named = /^\/(?:preview\/)?w\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/.exec(path)?.[1] ?? params.get('world');
  if (named) return named;
  for (const k of kinds()) if (k.startsWith('eden:')) return 'eden';
  return null;
}

const title = (name: string | null) => (name ? name.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => (d ? ' ' : '') + c.toUpperCase()) : 'this world');

/** What the welcome module needs of the camera director. */
export type Guide = { startTour(): boolean; leaveTour(): void; nextStop(): void };

const CSS = `
#welcome-card{position:fixed;z-index:20;left:50%;top:50%;transform:translate(-50%,-50%);width:min(380px,calc(100vw - 32px));box-sizing:border-box;
 padding:18px 20px;background:rgba(16,20,26,0.94);color:#e8e6e1;border:1px solid #3a4250;border-radius:8px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.4)}
#welcome-card h2{margin:2px 0 8px;font-size:20px;font-weight:600}
#welcome-card p{margin:0 0 10px}
#welcome-card .eyebrow{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9fb3c8}
#welcome-card .muted{color:#a9b0ba;font-size:13px}
#welcome-card .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
#welcome-card button,#tour-bar button,#tour-open{padding:8px 12px;border:1px solid #3a4250;border-radius:4px;background:#1d242e;color:#e8e6e1;font:13px system-ui,sans-serif;cursor:pointer}
#welcome-card button.primary{background:#3d6fb6;border-color:#3d6fb6;color:#fff}
#welcome-card button.close{position:absolute;right:8px;top:8px;border:0;background:none;font-size:20px;line-height:1;padding:4px 8px}
#tour-open{position:fixed;left:calc(min(240px,100vw - 24px) + 20px);bottom:12px;background:rgba(16,20,26,0.85)}
#tour-bar{position:fixed;z-index:12;left:50%;top:56px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;max-width:calc(100vw - 24px);box-sizing:border-box;
 padding:6px 8px 6px 12px;background:rgba(16,20,26,0.9);color:#e8e6e1;border:1px solid #3a4250;border-radius:6px;font:13px system-ui,sans-serif}
#tour-bar .where{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#tour-bar[hidden],#tour-open[hidden]{display:none}
@media (max-width:700px){#tour-open{left:12px;bottom:64px}#tour-bar{top:108px;left:12px;right:12px;transform:none}#tour-bar .where{flex:1}}
`;

export type Welcome = {
  card: HTMLElement | null;
  button: HTMLButtonElement | null;
  bar: HTMLElement;
  /** Each frame: the stop the tour is at (null when no tour runs). */
  frame(at: { stop: Stop; index: number; of: number } | null): void;
};

/** Mounts the card (unless this browser dismissed it), the Tour button and the tour's bar. `tour` is false where the
 *  world has no tour (not Eden). */
export function mountWelcome(doc: Document, guide: Guide, opts: { world: string | null; tour: boolean; store: () => Store | null | undefined }): Welcome {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) => Object.assign(doc.createElement(tag), props);
  const style = make('style', { id: 'welcome-style', textContent: CSS });
  doc.head.append(style);
  const name = title(opts.world);
  const start = () => {
    dismiss();
    guide.startTour();
  };

  let card: HTMLElement | null = null;
  const dismiss = () => {
    remember(opts.store);
    card?.remove();
    card = null;
    w.card = null;
  };
  if (!seen(opts.store)) {
    card = make('section', { id: 'welcome-card' });
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'welcome-title');
    const close = make('button', { className: 'close', textContent: '×', type: 'button' });
    close.setAttribute('aria-label', 'Close welcome');
    close.onclick = dismiss;
    const look = make('button', { textContent: 'Look around', type: 'button', onclick: dismiss });
    const actions = make('div', { className: 'actions' });
    if (opts.tour) actions.append(make('button', { className: 'primary', textContent: `Take the ${name} tour`, type: 'button', onclick: start }));
    actions.append(look);
    card.append(
      close,
      make('div', { className: 'eyebrow', textContent: 'Welcome' }),
      make('h2', { id: 'welcome-title', textContent: `Welcome to ${name}` }),
      make('p', { textContent: 'Souls live here, each one driven by its owner’s own agent. Watch what they do, tap a Soul to follow it, or find one by name.' }),
      make('p', { className: 'muted', textContent: 'Your first visit is now saved. Come back to see what happens here.' }),
      actions,
    );
    doc.body.append(card);
  }

  let button: HTMLButtonElement | null = null;
  if (opts.tour) {
    button = make('button', { id: 'tour-open', type: 'button', textContent: 'Tour', title: `Take the ${name} tour`, onclick: start });
    button.setAttribute('aria-label', `Take the ${name} tour`);
    doc.body.append(button);
  }

  const where = make('span', { className: 'where' });
  where.setAttribute('aria-live', 'polite');
  const bar = make('div', { id: 'tour-bar', hidden: true });
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', `${name} tour`);
  bar.append(where, make('button', { type: 'button', textContent: 'Next', onclick: () => guide.nextStop() }), make('button', { type: 'button', textContent: 'Leave tour', onclick: () => guide.leaveTour() }));
  doc.body.append(bar);
  // Esc leaves the tour, as a gesture on the world does.
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bar.hidden) guide.leaveTour();
  });

  let shown = '';
  const w: Welcome = {
    card,
    button,
    bar,
    frame(at) {
      const text = at ? `${name} tour · ${at.index + 1} of ${at.of} · ${at.stop.label}` : '';
      if (text === shown) return;
      shown = text;
      bar.hidden = !at;
      where.textContent = text;
      if (button) button.hidden = !!at;
    },
  };
  return w;
}

// The Explore list (#3738; today's EdenTour.tsx Explore dialog): Eden's views, searchable by name, each with a preview
// picture. Choosing one flies the camera there and gives the free camera from there; it moves the camera only and
// reads or changes no world state. ⌘K / Ctrl+K opens and closes it, Enter picks the first view shown, Esc closes it.
import type { Stop } from './stops.ts';

/** Lower case, accents removed: what the search compares ("cafe" finds "Corner café"), as today's `searchKey`. */
export const searchKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();

/** The views whose name holds the typed words, in the list's order; all of them for an empty search. */
export function matchViews(views: readonly Stop[], typed: string): Stop[] {
  const q = searchKey(typed.trim());
  return views.filter((v) => !q || searchKey(v.label).includes(q));
}

export type ExploreOpts = {
  world: string;
  views: readonly Stop[];
  /** Flies the camera to the view; false when it cannot now. */
  go(view: Stop): boolean;
  /** The view's picture, or null (the row keeps its drawn placeholder). */
  picture?(view: Stop): Promise<string | null>;
  /** The list closed: pictures not yet taken can be dropped. */
  closed?(): void;
};

const CSS = `
#explore-open{position:fixed;left:calc(min(240px,100vw - 24px) + 76px);bottom:12px;padding:8px 12px;border:1px solid #3a4250;border-radius:4px;background:rgba(16,20,26,0.85);color:#e8e6e1;font:13px system-ui,sans-serif;cursor:pointer}
#explore{position:fixed;z-index:22;left:50%;top:50%;transform:translate(-50%,-50%);width:min(720px,calc(100vw - 32px));max-height:min(640px,calc(100dvh - 32px));display:flex;flex-direction:column;box-sizing:border-box;
 padding:14px 16px 16px;background:rgba(16,20,26,0.96);color:#e8e6e1;border:1px solid #3a4250;border-radius:8px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.45)}
#explore[hidden]{display:none}
#explore header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
#explore h2{margin:0;font-size:18px;font-weight:600}
#explore header button{border:0;background:none;color:#e8e6e1;font-size:22px;line-height:1;padding:2px 8px;cursor:pointer}
#explore input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #3a4250;border-radius:4px;background:#0f141a;color:#e8e6e1;font:14px system-ui,sans-serif;margin-bottom:10px}
#explore .views{overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:2px}
#explore .views button{display:flex;flex-direction:column;gap:6px;padding:6px;border:1px solid #2c3440;border-radius:6px;background:#1a2029;color:#e8e6e1;font:13px system-ui,sans-serif;text-align:left;cursor:pointer}
#explore .views button:hover,#explore .views button:focus-visible{border-color:#5b8fd6;outline:none}
#explore .picture{display:block;width:100%;aspect-ratio:320/224;border-radius:4px;background:#26303c;object-fit:cover}
#explore .none{color:#a9b0ba;margin:8px 2px}
@media (max-width:700px){#explore-open{left:76px;bottom:64px}#explore{top:12px;transform:translateX(-50%);max-height:calc(100dvh - 24px);width:calc(100vw - 24px)}#explore .views{grid-template-columns:repeat(2,1fr)}}
`;

export type Explore = { button: HTMLButtonElement; panel: HTMLElement; open(): void; close(): void; readonly shown: Stop[] };

/** Mounts the Explore button and its list (hidden until opened). */
export function mountExplore(doc: Document, opts: ExploreOpts): Explore {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, props: object = {}): HTMLElementTagNameMap[K] => Object.assign(doc.createElement(tag), props);
  doc.head.append(make('style', { id: 'explore-style', textContent: CSS }));
  const label = `Explore ${opts.world}`;
  const button = make('button', { id: 'explore-open', type: 'button', textContent: 'Explore', title: `${label} (⌘K / Ctrl+K)` });
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  const panel = make('section', { id: 'explore', hidden: true });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'explore-title');
  const shut = make('button', { type: 'button', textContent: '×' });
  shut.setAttribute('aria-label', 'Close Explore');
  const header = make('header');
  header.append(make('h2', { id: 'explore-title', textContent: label }), shut);
  const search = make('input', { type: 'search', placeholder: 'Find a view…' });
  search.setAttribute('aria-label', 'Search views');
  const list = make('div', { className: 'views' });
  const none = make('p', { className: 'none', textContent: 'No matching views.', hidden: true });
  panel.append(header, search, list, none);
  doc.body.append(button, panel);

  // Pictures are asked for as rows come into sight, once per row per opening.
  const seen = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) (seen!.unobserve(e.target), load(e.target as HTMLButtonElement));
      }, { root: list, rootMargin: '80px' })
    : null;
  const rows = new Map<string, HTMLButtonElement>();
  const byRow = new Map<HTMLButtonElement, Stop>();
  const load = (row: HTMLButtonElement) => {
    const view = byRow.get(row), img = row.querySelector('img');
    if (!view || !img || img.dataset.asked) return;
    img.dataset.asked = '1';
    opts.picture?.(view).then((src) => {
      if (src && !panel.hidden) img.src = src;
      else delete img.dataset.asked;
    }, () => delete img.dataset.asked);
  };
  for (const view of opts.views) {
    const img = make('img', { className: 'picture', alt: '' });
    img.setAttribute('aria-hidden', 'true');
    const row = make('button', { type: 'button', onclick: () => pick(view) });
    row.dataset.view = view.id;
    row.append(img, make('span', { textContent: view.label }));
    rows.set(view.id, row);
    byRow.set(row, view);
    list.append(row);
  }

  let shown: Stop[] = [...opts.views];
  const filter = () => {
    shown = matchViews(opts.views, search.value);
    const keep = new Set(shown.map((v) => v.id));
    for (const [id, row] of rows) row.hidden = !keep.has(id);
    none.hidden = shown.length > 0;
  };
  const open = () => {
    if (!panel.hidden) return;
    search.value = '';
    filter();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    for (const row of rows.values()) seen ? seen.observe(row) : load(row);
    search.focus();
  };
  const close = () => {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    seen?.disconnect();
    opts.closed?.();
    button.focus();
  };
  const pick = (view: Stop) => {
    if (opts.go(view)) close();
  };
  button.onclick = () => (panel.hidden ? open() : close());
  shut.onclick = close;
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !shown.length) return;
    e.preventDefault();
    pick(shown[0]);
  });
  doc.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      return panel.hidden ? open() : close();
    }
    if (e.key === 'Escape' && !panel.hidden) close();
  });
  return { button, panel, open, close, get shown() { return shown; } };
}

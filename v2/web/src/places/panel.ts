// The places panel (#3676, parity with today's Explore place cards): a "places" button above the find box opens the
// list of named places, each with its preview picture; choosing one flies the place camera there. A place found in
// the find box shows the same card, picture and name, until the camera is taken back. Pictures are asked only for
// rows in view (IntersectionObserver), so opening the list draws a few, not all of them.
import { placeList, type Place } from './places.ts';

const BOX = 'position:fixed;left:12px;bottom:52px;box-sizing:border-box;background:rgba(16,20,26,0.9);color:#e8e6e1;'
  + 'border:1px solid #3a4250;border-radius:4px;font:13px system-ui,sans-serif;';

export type PanelHost = {
  /** Every node with a public name, as the copy holds them now. */
  nodes(): Iterable<{ id: string; placeName?: string | null; outline?: number[][] }>;
  /** The picture of place `id`, lazily. */
  picture(id: string): Promise<string | null>;
  /** Flies the place camera to `id`; false when it is not drawn. */
  choose(id: string): boolean;
};

export class PlacesPanel {
  readonly button: HTMLButtonElement;
  readonly list: HTMLDivElement;
  readonly card: HTMLDivElement;
  private host: PanelHost;
  private seen: IntersectionObserver | null = null;

  constructor(host: PanelHost) {
    this.host = host;
    const b = (this.button = document.createElement('button'));
    Object.assign(b, { id: 'places', type: 'button', textContent: 'places' });
    b.setAttribute('aria-expanded', 'false');
    b.style.cssText = BOX + 'padding:6px 10px;cursor:pointer';
    b.addEventListener('click', () => (this.list.hidden ? this.open() : this.close()));
    const l = (this.list = document.createElement('div'));
    l.id = 'place-list';
    l.setAttribute('role', 'listbox');
    l.setAttribute('aria-label', 'Places');
    l.hidden = true;
    l.style.cssText = BOX + 'bottom:92px;width:min(300px,calc(100vw - 24px));max-height:min(60vh,520px);overflow:auto;padding:6px';
    const c = (this.card = document.createElement('div'));
    c.id = 'place-card';
    c.hidden = true;
    c.style.cssText = BOX + 'bottom:92px;width:min(244px,calc(100vw - 24px));padding:6px';
    for (const e of [b, l, c]) e.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    document.body.append(b, l, c);
  }

  /** Opens the list of places, built from the copy as it is now. */
  open(): void {
    this.card.hidden = true;
    this.seen?.disconnect();
    this.seen = new IntersectionObserver((rows) => {
      for (const r of rows) if (r.isIntersecting) this.fill(r.target as HTMLElement), this.seen!.unobserve(r.target);
    }, { root: this.list });
    const places = placeList(this.host.nodes());
    this.list.replaceChildren(...(places.length ? places.map((p) => this.row(p)) : [note('no named places here yet')]));
    for (const r of this.list.querySelectorAll('[data-place]')) this.seen.observe(r);
    this.list.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
  }

  close(): void {
    this.list.hidden = true;
    this.seen?.disconnect();
    this.button.setAttribute('aria-expanded', 'false');
  }

  /** Shows the card of a place found in the find box. */
  show(p: Place): void {
    this.close();
    this.card.replaceChildren(picture(p.name), label(p.name));
    this.card.dataset.place = p.id;
    this.card.hidden = false;
    this.fill(this.card);
  }

  /** Hides the found place's card (the viewer took the camera back). */
  hide(): void {
    this.card.hidden = true;
  }

  private row(p: Place): HTMLElement {
    const r = document.createElement('button');
    r.type = 'button';
    r.dataset.place = p.id;
    r.setAttribute('role', 'option');
    r.style.cssText = 'display:flex;gap:8px;align-items:center;width:100%;padding:4px;margin:0 0 4px;background:none;'
      + 'color:inherit;border:0;border-radius:3px;text-align:left;font:inherit;cursor:pointer';
    const img = picture(p.name);
    img.style.width = '96px';
    img.style.flex = 'none';
    r.append(img, label(p.name));
    r.addEventListener('click', () => {
      if (!this.host.choose(p.id)) return void (r.title = 'not drawn yet');
      this.close();
      this.show(p);
    });
    return r;
  }

  /** Asks the picture of the place an element carries, and puts it in its image when it comes. */
  private fill(el: HTMLElement): void {
    const id = el.dataset.place, img = el.querySelector('img');
    if (!id || !img) return;
    void this.host.picture(id).then((url) => {
      if (url && el.dataset.place === id) (img.src = url), (img.style.visibility = 'visible');
    });
  }
}

/** A grey frame of the picture's shape, its image shown once it is drawn. */
const picture = (name: string) => {
  const frame = document.createElement('div'), img = document.createElement('img');
  frame.style.cssText = 'aspect-ratio:320/224;background:#2a3038;border-radius:3px;overflow:hidden';
  img.alt = `${name}, preview`;
  img.width = 320;
  img.height = 224;
  img.style.cssText = 'display:block;width:100%;height:100%;visibility:hidden';
  frame.append(img);
  return frame;
};
const label = (name: string) => {
  const s = document.createElement('span');
  s.textContent = name;
  s.style.cssText = 'display:block;padding:4px 2px 0';
  return s;
};
const note = (text: string) => label(text);

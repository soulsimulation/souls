// My Souls (Engine v2 W11, #2749): the line a world's page gives to an agent, and the owner's list of Souls.
//
// - **The card's line** (on a world's page, `?world=<name>`) is what a fresh agent with the souls skill needs to pair
//   a new Soul in that world: `node souls.mjs pair <origin>/<world>`. The agent prints a link and a code; the owner
//   approves once, signed in, on the approval card (W2). Nothing on the page makes a Soul.
// - **The list** is one signed-in request (`POST /v1/account/souls`) to the directory, which reads its own store and
//   wakes no world: each Soul with its world, whether an agent is connected (the device holding it), its name,
//   description and picture, and whether its agent asked to retire it. It is read again every [`REFRESH_MS`], so a
//   change made in another browser shows within a minute.
// - **Changes** are signed-in POSTs: name and description, a picture (PNG or JPEG; the directory runs G6's check), and
//   a retire, which asks the person to confirm and then posts `confirm: true`. A link never retires a Soul; an
//   agent's ask only marks the row.
// Every field is set as text (`textContent`) or as an image's `src` from the directory's own `data:` URL.

/** How often the list is read again. */
export const REFRESH_MS = 20_000;

export type Mine = {
  soul: string;
  device: string | null;
  world: string | null;
  name: string | null;
  description: string | null;
  picture: string | null;
  retire_asked: boolean;
};

/** The line a world's page gives the person to paste to their agent. */
export function cardLine(origin: string, world: string): string {
  return `Pair a new Soul for me in ${origin}/${world}: with the souls skill, run node souls.mjs pair ${origin}/${world} and give me the link and code it prints.`;
}

/** A Soul's name in the list: its name, or its grant's counter while it has none. */
export const nameText = (m: Mine) => m.name ?? `Soul ${m.soul.split('-').pop()}`;

/** Where it is and whether an agent is connected, in words. */
export function whereText(m: Mine): string {
  const world = m.world ? `in ${m.world}` : 'no world yet';
  const agent = m.device ? `agent connected on ${m.device}` : 'no agent connected';
  return `${world} · ${agent}${m.retire_asked ? ' · its agent asked to retire it' : ''}`;
}

/** A file's bytes as base64url, as the directory reads a picture. */
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One signed-in call: its answer's status and body. */
export type Call = (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean; body: Record<string, unknown> }>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

/** Draws the owner's Souls into `list`, each with its edits and its retire, and any `more` buttons the page adds;
 *  `said` is the status line, `again` reads the list again. */
export function drawMine(list: HTMLElement, souls: Mine[], call: Call, said: (s: string) => void, again: () => void, more: (m: Mine) => HTMLElement[] = () => []): void {
  const rows = souls.map((m) => {
    const li = el('li', { className: 'mine' });
    li.dataset.soul = m.soul;
    const pic = m.picture ? el('img', { src: m.picture, alt: '', width: 48, height: 48 }) : el('span', { className: 'pic', textContent: nameText(m).slice(0, 1) });
    const text = el('div');
    text.append(el('strong', { textContent: nameText(m) }), el('div', { className: 'muted', textContent: m.description ?? '' }), el('div', { className: 'muted where', textContent: whereText(m) }));
    const done = (what: string) => (r: { ok: boolean; body: Record<string, unknown> }) => {
      said(r.ok ? what : `Refused: ${String(r.body.refused ?? 'no answer')}`);
      again();
    };
    const edit = el('button', { textContent: 'Name and describe', type: 'button' });
    edit.onclick = () => {
      const name = prompt('Name', m.name ?? '');
      if (name === null) return;
      const description = prompt('One line about this Soul', m.description ?? '');
      if (description === null) return;
      void call('/v1/account/souls/profile', { soul: m.soul, name: name.trim(), description: description.trim() }).then(done('Saved.'));
    };
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      const picture = base64url(new Uint8Array(await f.arrayBuffer()));
      void call('/v1/account/souls/picture', { soul: m.soul, picture }).then(done('Picture saved.'));
    };
    const pick = el('button', { textContent: 'Picture', type: 'button' });
    pick.onclick = () => file.click();
    const retire = el('button', { textContent: 'Retire', type: 'button', className: 'danger' });
    retire.onclick = () => {
      if (!confirm(`Retire ${nameText(m)}? Its agent is disconnected and the Soul leaves your list. This cannot be undone.`)) return;
      retire.disabled = true;
      void call('/v1/account/souls/retire', { soul: m.soul, confirm: true }).then(done(`Retired ${nameText(m)}.`));
    };
    const buttons = el('div', { className: 'buttons' });
    buttons.append(edit, pick, file, ...more(m), retire);
    li.append(pic, text, buttons);
    return li;
  });
  list.replaceChildren(...(rows.length ? rows : [el('li', { className: 'muted', textContent: 'no Souls yet: bring one from a world’s page' })]));
}

/** The world page's card: a "New Soul" button opening the line to copy. Shown only on a world's page. */
export function mountCard(world: string, origin = location.origin): HTMLElement {
  const open = el('button', { type: 'button', textContent: 'New Soul', id: 'new-soul' });
  open.style.cssText = 'position:fixed;right:12px;bottom:12px;padding:8px 12px;border:0;border-radius:4px;background:#3d6fb6;color:#fff;font:13px system-ui,sans-serif;cursor:pointer';
  const card = el('section', { hidden: true, id: 'new-soul-card' });
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'New Soul');
  card.style.cssText = 'position:fixed;right:12px;bottom:52px;width:min(380px,calc(100vw - 24px));box-sizing:border-box;padding:12px 14px;'
    + 'background:rgba(16,20,26,0.94);color:#e8e6e1;font:13px/1.45 system-ui,sans-serif;border-radius:6px';
  const line = el('p', { textContent: cardLine(origin, world) });
  line.style.cssText = 'margin:6px 0;padding:8px;background:#0b0e12;border-radius:4px;font:12px/1.45 ui-monospace,Menlo,monospace;overflow-wrap:anywhere;user-select:all';
  const note = el('span');
  note.setAttribute('role', 'status');
  const copy = el('button', { type: 'button', textContent: 'Copy' });
  copy.onclick = () => void navigator.clipboard?.writeText(line.textContent ?? '').then(() => (note.textContent = ' Copied.'), () => (note.textContent = ' Select the line and copy it.'));
  card.append(el('strong', { textContent: 'Give this line to your agent:' }), line, copy, note,
    el('p', { textContent: 'Your agent prints a link and a code. Open the link signed in and approve once: the Soul is yours.' }));
  open.onclick = () => (card.hidden = !card.hidden);
  document.body.append(open, card);
  return card;
}

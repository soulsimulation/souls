// The list of worlds, and making one (Engine v2 W3, #2799).
//
// - The list is one request, `GET /v1/worlds`, answered from the directory's cached copy; it asks no world anything.
// - Create shows progress on the click itself, before the request leaves, and counts the seconds until the answer.
// - One click is one key: the key is made when the form is sent and kept until an answer, so a second click (or a
//   retry after a dropped answer) makes the same world. The directory keeps the answer by key.
// - The world's page opens on the answer; the click's time goes with it, so that page can time its first frame.
// - Sign-in here is W1's sign-in for test worlds (`Bearer test:<name>`); a provider's token rides the same header.

export type Row = { name: string; label: string; template: string; awake: boolean; picture: string | null; closed?: boolean };
export type Listing = { worlds: Row[]; templates: string[] };

/** What a refusal says, in words: a limit's name and when to retry. */
export function refusalText(status: number, body: { refused?: string; limit?: string; retry_after?: number | null; detail?: string }): string {
  if (status === 429 && body.limit) {
    const wait = body.retry_after == null ? 'It does not lift with time.' : `Try again in ${retryText(body.retry_after)}.`;
    return `Refused: the limit is ${body.limit}. ${wait}`;
  }
  return `Refused: ${body.refused ?? `HTTP ${status}`}${body.detail ? ` (${body.detail})` : ''}`;
}

export function retryText(secs: number): string {
  if (secs < 90) return `${secs} s`;
  if (secs < 5400) return `${Math.ceil(secs / 60)} min`;
  return `${Math.ceil(secs / 3600)} h`;
}

/** The key for one click: made once, kept until the click has an answer. */
export class ClickKey {
  private key: string | null = null;
  private readonly make: () => string;
  constructor(make: () => string = () => crypto.randomUUID()) {
    this.make = make;
  }
  take(): string {
    return (this.key ??= this.make());
  }
  answered(): void {
    this.key = null;
  }
}

function page(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const list = $<HTMLUListElement>('list'), form = $<HTMLFormElement>('create'), go = $<HTMLButtonElement>('go');
  const progress = $<HTMLDivElement>('progress'), template = $<HTMLSelectElement>('template');
  const who = $<HTMLInputElement>('who'), label = $<HTMLInputElement>('label'), name = $<HTMLInputElement>('name');
  const key = new ClickKey();
  let busy = false;

  fetch('/v1/worlds').then((r) => r.json() as Promise<Listing>).then((l) => {
    list.replaceChildren(...(l.worlds.length ? l.worlds.map((w) => {
      const li = document.createElement('li'), a = document.createElement('a'), s = document.createElement('span');
      a.textContent = w.name;
      a.href = `../../?world=${encodeURIComponent(w.name)}`;
      s.className = 'muted';
      s.textContent = `${w.label} · ${w.template} · ${w.awake ? 'awake' : 'asleep'}${w.closed ? ' · closed to visitors' : ''}`;
      li.append(a, s);
      return li;
    }) : [Object.assign(document.createElement('li'), { className: 'muted', textContent: 'no worlds yet' })]));
    template.replaceChildren(...l.templates.map((t) => Object.assign(document.createElement('option'), { value: t, textContent: t })));
  }, () => (list.textContent = 'the list could not be read'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return; // a second click while the first is out: the same world, nothing more to send
    busy = true;
    const clickAt = performance.timeOrigin + performance.now();
    performance.mark('create-click');
    go.disabled = true;
    progress.className = '';
    progress.textContent = `Making ${name.value}…`;
    const tick = setInterval(() => (progress.textContent = `Making ${name.value}… ${((Date.now() - clickAt) / 1000).toFixed(1)} s`), 100);
    try {
      const r = await fetch('/v1/worlds', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer test:${who.value}` },
        body: JSON.stringify({ key: key.take(), name: name.value, template: template.value, label: label.value }),
      });
      const body = await r.json();
      key.answered();
      if (!r.ok) {
        progress.className = 'refused';
        progress.textContent = refusalText(r.status, body);
        return;
      }
      progress.textContent = `Made ${name.value}; opening it…`;
      sessionStorage.setItem('v2-created', JSON.stringify({ world: body.world.name, clickAt }));
      location.href = `../../?world=${encodeURIComponent(body.world.name)}`;
    } catch {
      // No answer: the key is kept, so sending again cannot make a second world.
      progress.className = 'refused';
      progress.textContent = 'No answer from the directory; send again to retry the same click.';
    } finally {
      clearInterval(tick);
      busy = false;
      go.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') page();

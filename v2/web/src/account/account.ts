// The account page and a world's settings (Engine v2 W9, #2827).
//
// - Your Souls: each with the device that holds it, from W2's pairings (`POST /v1/account/souls`). Revoke ends the
//   Soul's token at the gateway (`POST /v1/account/souls/revoke`): its next intent is refused, `token.refused`. A
//   revoke takes the Soul to no other device; only the agent's own pairing does that.
// - A world's settings, by its creator (`POST /v1/worlds/settings`): open or closed to visitors (today's one travel
//   switch), and on or off the list. Off the list is the directory's flag alone and wakes no world.
// - Signed in means W1's session token (kept by the web app in sessionStorage as `souls.session`), or on a test world
//   W1's test person typed here. Neither is ever put in a URL.

import { REFRESH_MS, drawMine, type Mine } from '../souls/mine.ts';

export type Soul = { soul: string; device: string | null };
export type WorldRow = { name: string; label: string; unlisted?: boolean; closed?: boolean };

/** Who is signed in: a session token, or a test person's name. */
export type Who = { session: string } | { person: string };

/** The request for a directory call as `who`: pairing's routes take a test person in the body, the world routes as
 * `Bearer test:<name>`; a session token is a bearer for both. */
export function request(who: Who, kind: 'account' | 'world', body: Record<string, unknown>): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if ('session' in who) headers.authorization = `Bearer ${who.session}`;
  else if (kind === 'world') headers.authorization = `Bearer test:${who.person}`;
  else body = { ...body, test_person: who.person };
  return { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit' };
}

/** A Soul's device, in words. */
export function deviceText(s: Soul): string {
  return s.device ? `on ${s.device}` : 'no device';
}

/** A world's two switches, in words. */
export function settingsText(w: WorldRow): string {
  return `${w.closed ? 'closed to visitors' : 'open to visitors'} · ${w.unlisted ? 'off the list' : 'on the list'}`;
}

function page(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let who: Who | null = null;
  try {
    const s = sessionStorage.getItem('souls.session');
    if (s) who = { session: s };
  } catch { /* storage blocked */ }
  const said = $<HTMLParagraphElement>('said');
  const call = async (path: string, kind: 'account' | 'world', body: Record<string, unknown>) => {
    const r = await fetch(path, request(who as Who, kind, body));
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };

  async function souls(): Promise<void> {
    const { ok, body } = await call('/v1/account/souls', 'account', {});
    const list = $<HTMLUListElement>('souls');
    if (!ok) {
      list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: `Could not read your Souls: ${body.refused ?? 'no answer'}` }));
      return;
    }
    // W11 (#2749): each Soul's world, connection, name, description and picture, its edits and its retire.
    drawMine(list, body.souls as Mine[], (path, b) => call(path, 'account', b), (s) => (said.textContent = s), () => void souls(), (s) => {
      if (!s.device) return [];
      const b = Object.assign(document.createElement('button'), { textContent: 'Revoke', type: 'button' });
      b.onclick = async () => {
        if (!confirm(`Revoke ${s.device}'s hold on this Soul? Its agent is disconnected at once.`)) return;
        b.disabled = true;
        const r = await call('/v1/account/souls/revoke', 'account', { soul: s.soul });
        said.textContent = r.ok ? `Revoked: ${s.device} no longer holds the Soul.` : `Refused: ${r.body.refused}`;
        void souls();
      };
      return [b];
    });
  }

  let world: WorldRow | null = null;
  function showWorld(): void {
    $('settings').hidden = !world;
    if (!world) return;
    $('world-name').textContent = `${world.name} (${world.label})`;
    $('world-state').textContent = settingsText(world);
    $<HTMLInputElement>('open').checked = !world.closed;
    $<HTMLInputElement>('listed').checked = !world.unlisted;
  }
  async function settings(change: Record<string, boolean>): Promise<void> {
    const name = $<HTMLInputElement>('world').value.trim();
    const r = await call('/v1/worlds/settings', 'world', { world: name, ...change });
    world = r.ok ? (r.body.world as WorldRow) : null;
    said.textContent = r.ok ? (Object.keys(change).length ? `Saved: ${settingsText(world as WorldRow)}.` : '') : `Refused: ${r.body.refused ?? `HTTP ${r.status}`}`;
    showWorld();
  }
  $<HTMLFormElement>('pick').onsubmit = (e) => { e.preventDefault(); void settings({}); };
  $<HTMLInputElement>('open').onchange = (e) => void settings({ closed: !(e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('listed').onchange = (e) => void settings({ unlisted: !(e.target as HTMLInputElement).checked });

  const start = () => {
    $('who').hidden = true;
    $('signed').hidden = false;
    const w = new URLSearchParams(location.search).get('world');
    if (w) {
      $<HTMLInputElement>('world').value = w;
      void settings({});
    }
    void souls();
    setInterval(() => void souls(), REFRESH_MS);
  };
  $<HTMLFormElement>('who').onsubmit = (e) => {
    e.preventDefault();
    who = { person: $<HTMLInputElement>('person').value.trim() };
    start();
  };
  if (who) start();
  else $('who').hidden = false;
}

if (typeof document !== 'undefined') page();

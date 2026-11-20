// The account page and a world's settings (Engine v2 W9, #2827).
//
// - Your Souls: each with the device that holds it, from W2's pairings (`POST /v1/account/souls`). Revoke ends the
//   Soul's token at the gateway (`POST /v1/account/souls/revoke`): its next intent is refused, `token.refused`. A
//   revoke takes the Soul to no other device; only the agent's own pairing does that.
// - A world's settings, by its creator (`POST /v1/worlds/settings`): open or closed to visitors (today's one travel
//   switch), and on or off the list. Off the list is the directory's flag alone and wakes no world.
// - Sign-in uses the provider session with a fresh bearer per request, or an explicit local test person on HTTP
//   loopback. No raw session token is copied, persisted or put in a URL.

import { browserSession, localTestSignIn, sessionRequest, type BrowserSession } from '../source/signin.ts';
import type { Session } from '../source/socket.ts';
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
  let who: BrowserSession | null = null, generation = 0;
  let unsubscribe: (() => void) | undefined, refresh: ReturnType<typeof setInterval> | undefined;
  function invalidate() {
    generation++; who = null; unsubscribe?.(); unsubscribe = undefined;
    if (refresh) clearInterval(refresh); refresh = undefined;
    $('signed').hidden = true; $('signin').hidden = false;
    $('who').hidden = !localTestSignIn(location.href);
    $('souls').replaceChildren(); $('agents').replaceChildren();
    world = null; showWorld();
  }
  const said = $<HTMLParagraphElement>('said');
  const call = async (path: string, kind: 'account' | 'world', body: Record<string, unknown>) => {
    const owned = who, attempt = generation;
    if (!owned) throw new Error('Sign in again.');
    const init = await sessionRequest(owned, kind, body);
    if (attempt !== generation || who !== owned) throw new Error('Account changed.');
    const r = await fetch(path, init), answer = await r.json().catch(() => ({}));
    if (attempt !== generation || who !== owned) throw new Error('Account changed.');
    return { ok: r.ok, status: r.status, body: answer };
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

  async function agents(): Promise<void> {
    const { ok, body } = await call('/v1/account/agents', 'account', {});
    const list = $('agents'); list.replaceChildren();
    if (!ok) { list.textContent = `Could not read connected agents: ${body.refused ?? 'no answer'}`; return; }
    for (const agent of body.agents ?? []) {
      const row = document.createElement('li');
      row.textContent = `${agent.agentLabel} on ${agent.device.name} `;
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Disconnect account' });
      button.onclick = async () => {
        if (!confirm('Disconnect this account login? Soul credentials and memories stay where they are.')) return;
        button.disabled = true;
        const r = await call(`/v1/account/agents/${encodeURIComponent(agent.id)}/revoke`, 'account', {});
        said.textContent = r.ok ? 'Account login disconnected. Soul credentials and memories are unchanged.' : `Refused: ${r.body.refused}`;
        await agents();
      };
      row.append(button); list.append(row);
    }
    if (!list.childElementCount) list.textContent = 'No connected agents.';
  }
  const refreshPrivate = () => Promise.all([souls(), agents()]).catch((e: Error) => { said.textContent = e.message; });

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
    void refreshPrivate();
    refresh = setInterval(() => { if (who) void refreshPrivate(); }, REFRESH_MS);
  };
  const signIn = async () => {
    try {
      invalidate(); const attempt = generation;
      const next = await browserSession($<HTMLInputElement>('person').value);
      if (generation !== attempt) return;
      who = next;
      if (next) {
        unsubscribe = next.subscribeIdentity?.(() => { invalidate(); said.textContent = 'Account changed. Sign in again.'; });
        if (who === next) { $('signin').hidden = true; start(); }
        else { unsubscribe?.(); unsubscribe = undefined; }
      }
      else said.textContent = 'Finish signing in, then select Sign in again.';
    } catch (e) { said.textContent = (e as Error).message; }
  };
  $<HTMLFormElement>('who').onsubmit = (e) => { e.preventDefault(); void signIn(); };
  $('who').hidden = !localTestSignIn(location.href);
  $('signin').onclick = () => void signIn();
}

if (typeof document !== 'undefined') page();

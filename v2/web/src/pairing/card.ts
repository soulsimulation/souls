import { browserSession, localTestSignIn, sessionRequest } from '../source/signin.ts';
import type { Session } from '../source/socket.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const code = new URLSearchParams(location.search).get('code') ?? '';
let session: Session | null = null;
const person = () => $<HTMLInputElement>('person').value.trim();
async function post(path: string, body: Record<string, unknown>) {
  const r = await fetch(path, await sessionRequest(session!, 'account', body));
  return { status: r.status, body: await r.json() };
}
const age = (s: number) => s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 129600 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`;
async function show() {
  const { status, body } = await post('/v1/pair/show', { code });
  if (status !== 200) { $('said').textContent = `Nothing to approve: ${body.refused}`; return; }
  $('code').textContent = body.code;
  $('device').textContent = body.device;
  $('label').textContent = body.label;
  $('soul').textContent = body.soul ?? (body.former ? `${body.former}, brought over from today's client` : 'a new Soul');
  $('age').textContent = age(body.age);
  $('connected').textContent = body.connected
    ? `${body.connected}${body.force ? ' (this request replaces it)' : ' (this request will be refused unless the agent forces it)'}`
    : 'no device';
  $('who').hidden = true;
  $('card').hidden = false;
}
$('match').onchange = () => { $<HTMLButtonElement>('approve').disabled = !$<HTMLInputElement>('match').checked; };
$('approve').onclick = async () => {
  $<HTMLButtonElement>('approve').disabled = true;
  const { status, body } = await post('/v1/pair/approve', { code, confirm: true });
  $('said').textContent = status === 200 ? 'Approved. The device now holds your Soul.'
    : `Refused: ${body.refused}${body.device ? ` (connected to ${body.device})` : ''}`;
};
const signIn = async () => {
  try {
    session = await browserSession(person());
    if (session) { $('signin').hidden = true; await show(); }
    else $('said').textContent = 'Finish signing in, then select Sign in again.';
  } catch (e) { $('said').textContent = (e as Error).message; }
};
$<HTMLFormElement>('who').onsubmit = (e) => { e.preventDefault(); void signIn(); };
$('who').hidden = !localTestSignIn(location.href);
$('signin').onclick = () => void signIn();

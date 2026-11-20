import { browserSession, localTestSignIn, sessionRequest, type BrowserSession } from '../source/signin.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const code = params.get('code') ?? '', request = params.get('request');
let session: BrowserSession | null = null, generation = 0;
let unsubscribe: (() => void) | undefined;
const person = () => $<HTMLInputElement>('person').value.trim();
function invalidate() {
  generation++; session = null; unsubscribe?.(); unsubscribe = undefined;
  $('card').hidden = true; $('signin').hidden = false;
  $('who').hidden = !localTestSignIn(location.href);
  $<HTMLInputElement>('match').checked = false;
  $<HTMLButtonElement>('approve').disabled = true;
  for (const id of ['code', 'device', 'label', 'soul', 'age', 'connected']) $(id).textContent = '';
}
async function post(path: string, body: Record<string, unknown>) {
  const owned = session, attempt = generation;
  if (!owned) throw new Error('Sign in again.');
  const init = await sessionRequest(owned, 'account', body);
  if (session !== owned || attempt !== generation) throw new Error('Account changed. Sign in again.');
  const r = await fetch(path, init), answer = await r.json();
  if (session !== owned || attempt !== generation) throw new Error('Account changed. Sign in again.');
  return { status: r.status, body: answer };
}
const age = (s: number) => s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 129600 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`;
const accountPath = `/v1/account/requests/${encodeURIComponent(request ?? '')}`;
async function show() {
  const { status, body } = await post(request ? accountPath : '/v1/pair/show', { code });
  if (status !== 200) { $('said').textContent = `Nothing to approve: ${body.refused}`; return; }
  if (request) {
    const r = body.request;
    $('heading').textContent = 'Connect this computer to your account';
    $('code').textContent = r.confirm; $('device').textContent = r.device.name; $('label').textContent = r.agentLabel;
    $('soul').textContent = 'Your account: this agent may list and adopt your Souls without another code.';
    const seconds = Math.max(0, (Date.now() - r.createdAt) / 1000);
    $('age').textContent = `${age(seconds)}${seconds > 86400 ? ' — an older request; check carefully that you started it' : ''}`;
    $('connected').textContent = r.status === 'pending' ? 'Waiting for your approval. You can disconnect this agent on your account page.' : r.status;
    $<HTMLButtonElement>('approve').disabled = r.status !== 'pending';
    $('card').hidden = r.status !== 'pending';
    $('cancel').hidden = r.status !== 'pending';
    if (r.status !== 'pending') $('said').textContent = `Request ${r.status}.`;
  } else {
    $('code').textContent = body.code; $('device').textContent = body.device; $('label').textContent = body.label;
    $('soul').textContent = body.soul ?? (body.former ? `${body.former}, brought over from today's client` : 'a new Soul');
    $('age').textContent = age(body.age);
    $('connected').textContent = body.connected ? `${body.connected}${body.force ? ' (this request replaces it)' : ' (this request will be refused unless the agent forces it)'}` : 'no device';
    $('card').hidden = false;
  }
  $('who').hidden = true;
}
$('match').onchange = () => { $<HTMLButtonElement>('approve').disabled = !$<HTMLInputElement>('match').checked; };
$('approve').onclick = async () => {
  if (!session || !$<HTMLInputElement>('match').checked) return;
  $<HTMLButtonElement>('approve').disabled = true;
  try {
    const { status, body } = await post(request ? `${accountPath}/approve` : '/v1/pair/approve', { code, confirm: true });
    $('said').textContent = status === 200 ? request ? 'Approved. This computer can now connect to your account.' : 'Approved. The device now holds your Soul.'
      : `Refused: ${body.refused}${body.device ? ` (connected to ${body.device})` : ''}`;
  } catch (e) { $('said').textContent = (e as Error).message; }
};
$('cancel').onclick = async () => {
  if (!request || !session) return;
  try {
    const { status, body } = await post(`${accountPath}/cancel`, {});
    $('said').textContent = status === 200 ? 'Request refused.' : `Refused: ${body.refused}`;
    if (status === 200) $('card').hidden = true;
  } catch (e) { $('said').textContent = (e as Error).message; }
};
const signIn = async () => {
  invalidate(); const attempt = generation;
  try {
    const next = await browserSession(person());
    if (attempt !== generation) return;
    session = next;
    if (next) {
      unsubscribe = next.subscribeIdentity?.(() => { invalidate(); $('said').textContent = 'Account changed. Sign in again.'; });
      if (session === next) { $('signin').hidden = true; await show(); }
      else { unsubscribe?.(); unsubscribe = undefined; }
    } else $('said').textContent = 'Finish signing in, then select Sign in again.';
  } catch (e) { $('said').textContent = (e as Error).message; }
};
$<HTMLFormElement>('who').onsubmit = (e) => { e.preventDefault(); void signIn(); };
$('who').hidden = !localTestSignIn(location.href);
$('signin').onclick = () => void signIn();

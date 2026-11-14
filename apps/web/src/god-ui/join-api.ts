// "Join this world as a Soul" (lane P2), exactly as on the live worlds: the person's agent asks for the Soul with the
// Soul CLI (`create-soul`, or `pair-soul` to reconnect one) and prints an approval link (#approve/<id>); the signed-in
// person approves it on this page; the agent's `approval wait` connects. Only existing endpoints: /v1/me, the public
// /v1/world/souls, and main's account approvals (/v1/account/approvals/:id[/approve|/cancel]). Who is signed in comes
// from auth-session.ts, the one place.
import { apiPath, worldPath } from '../world-path.ts';
import { userAuthHeaders } from '../auth-session.ts';

export type MySoul = { id: string; name: string; entityId: string; hasToken: boolean };
export type SoulHere = { id: string; entityId: string; name: string; since: number; active: boolean; p?: [number, number, number] };
export type Approval = { id: string; worldId: string; agentLabel: string; name: string; description: string; mode: 'create' | 'repair'; status: 'pending' | 'creating' | 'ready' | 'refused' | 'cancelled' | 'expired'; soulId: string | null; expiresAt: number; reason?: { code: string; message: string };
  /** Lane PUX: addressed to this account with a window code, so its open world window shows it; the Soul's picture once it exists. */
  inWindow?: boolean; photo?: string | null };
/** #2245 (`account-grant/1`, #2242): an agent asks to log in to the account, or to retire one of its Souls. */
// #2258: a request has no expiry (`expired` is only an older world's); `ended` says who ended a cancelled one.
export type AccountRequest = { id: string; kind: 'login' | 'retire'; status: 'pending' | 'ready' | 'cancelled' | 'expired'; agentLabel: string; device: { name: string };
  soul: { id: string; name: string } | null; confirm: string; createdAt: number; inWindow: boolean; ended?: 'refused' | 'cancelled' | 'replaced' };
/** One live account login (grant) of this account. */
export type ConnectedAgent = { id: string; agentLabel: string; device: { name: string }; createdAt: number; lastUsedAt: number | null };
/** An error answer: the server's `{ok:false, code, message}`, or the contract's `{error:{code, message}}`. */
type ErrorBody = { code?: string; message?: string; error?: { code?: string; message?: string } };
const errorMessage = (d: ErrorBody) => d.error?.message ?? d.message;

/** The signed-in person's Souls in this world; null when nobody is signed in (or the world refuses them). */
export async function mySouls(): Promise<MySoul[] | null> {
  const headers = await userAuthHeaders(); if (!headers.authorization) return null;
  try { const r = await fetch(apiPath('/v1/me'), { headers, cache: 'no-store' }); if (!r.ok) return null; const d = await r.json() as { souls?: MySoul[] }; return d.souls ?? []; } catch { return null; }
}
/** Everyone who lives here (public). */
export async function soulsHere(): Promise<SoulHere[]> {
  try { const r = await fetch(apiPath('/v1/world/souls'), { cache: 'no-store' }); return r.ok ? ((await r.json()) as { souls: SoulHere[] }).souls : []; } catch { return []; }
}

/** The URL fragment the page was opened with, read when this module loads: the page shell rewrites the fragment to its
 *  own tab once it renders, so `#join` and `#approve/<id>` must be caught before that. */
export const landingHash = typeof location === 'undefined' ? '' : location.hash;
/** `#approve/ap_…` — the link the Soul CLI prints for its human (main's format). */
export { approvalFromHash } from '../approval-link.ts';
import { validApproval } from '../approval-link.ts';
const valid = (a: Approval | undefined, id: string, worldId?: string): a is Approval => validApproval(a, id, worldId);
/** Read (or act on) one approval as the signed-in person. */
export async function approval(id: string, action?: 'approve' | 'cancel' | 'renew'): Promise<Approval> {
  const headers = await userAuthHeaders(); if (!headers.authorization) throw new Error('Sign in first.');
  const r = await fetch(apiPath(`/v1/account/approvals/${id}${action ? '/' + action : ''}`), { method: action ? 'POST' : 'GET', headers: { ...headers, ...(action ? { 'content-type': 'application/json' } : {}) }, ...(action ? { body: '{}' } : {}), cache: 'no-store' });
  const d = await r.json().catch(() => ({})) as { approval?: Approval; message?: string; world?: { id?: string } };
  if (r.ok && valid(d.approval, id) && !valid(d.approval, id, d.world?.id ?? '')) throw new Error('This request is for another world.');
  if (!r.ok || !valid(d.approval, id, d.world?.id ?? '')) throw new Error(r.status === 403 ? 'This approval belongs to another account.' : d.message ?? 'This approval is unavailable. Sign in with the intended account and check again.');
  return d.approval;
}
/** Lane PUX: the requests waiting for this account in this world (addressed to it with a window code), newest first;
 *  #2245: with the account requests (login, retire) of the same answer. null = this world has no such list (an older
 *  server), stop asking. */
export async function waitingApprovals(): Promise<{ approvals: Approval[]; requests: AccountRequest[] } | null> {
  const none = { approvals: [], requests: [] };
  const headers = await userAuthHeaders(); if (!headers.authorization) return none;
  try {
    const r = await fetch(apiPath('/v1/account/approvals'), { headers, cache: 'no-store' });
    if (r.status === 404 || r.status === 405) return null;
    if (!r.ok) return none;
    const d = await r.json() as { approvals?: Approval[]; requests?: AccountRequest[] };
    return { approvals: (d.approvals ?? []).filter((a) => a && typeof a.id === 'string' && valid(a, a.id)),
      requests: (Array.isArray(d.requests) ? d.requests : []).filter((q) => q && typeof q.id === 'string' && validRequest(q, q.id)) };
  } catch { return none; }
}
const KINDS = ['login', 'retire'], REQUEST_STATUSES = ['pending', 'ready', 'cancelled', 'expired'];
/** A world's answer about one account request is that request, well formed (its texts are the agent's, shown as such). */
export function validRequest(value: unknown, id: string): value is AccountRequest {
  const q = value as Partial<AccountRequest> | null;
  return !!q && typeof q === 'object' && q.id === id && /^aq_[a-f0-9]{32}$/.test(id) && KINDS.includes(q.kind as string) && REQUEST_STATUSES.includes(q.status as string)
    && typeof q.agentLabel === 'string' && typeof q.device?.name === 'string' && typeof q.confirm === 'string'
    && (q.kind === 'login' || (typeof q.soul?.id === 'string' && typeof q.soul?.name === 'string'));
}
/** #2245: read (or answer) one account request as the signed-in person. */
export async function accountRequest(id: string, action?: 'approve' | 'cancel'): Promise<AccountRequest> {
  const headers = await userAuthHeaders(); if (!headers.authorization) throw new Error('Sign in first.');
  const r = await fetch(apiPath(`/v1/account/requests/${id}${action ? '/' + action : ''}`), { method: action ? 'POST' : 'GET', headers: { ...headers, ...(action ? { 'content-type': 'application/json' } : {}) }, ...(action ? { body: '{}' } : {}), cache: 'no-store' });
  const d = await r.json().catch(() => ({})) as ErrorBody & { request?: AccountRequest };
  if (!r.ok || !validRequest(d.request, id)) throw new Error(r.status === 403 ? 'This request belongs to another account.' : errorMessage(d) ?? 'This request is unavailable. Sign in with the intended account and check again.');
  return d.request;
}
/** #2245: the agents logged in to this account (its live grants); null when this world has no such list. */
export async function connectedAgents(): Promise<ConnectedAgent[] | null> {
  const headers = await userAuthHeaders(); if (!headers.authorization) return null;
  try {
    const r = await fetch(apiPath('/v1/account/agents'), { headers, cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json() as { agents?: ConnectedAgent[] };
    return (Array.isArray(d.agents) ? d.agents : []).filter((g) => g && typeof g.id === 'string' && typeof g.agentLabel === 'string' && typeof g.device?.name === 'string');
  } catch { return null; }
}
/** #2245: end one agent's login to this account. */
export async function disconnectAgent(id: string): Promise<void> {
  const headers = await userAuthHeaders(); if (!headers.authorization) throw new Error('Sign in first.');
  const r = await fetch(apiPath(`/v1/account/agents/${encodeURIComponent(id)}/revoke`), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}', cache: 'no-store' });
  if (!r.ok) throw new Error(errorMessage(await r.json().catch(() => ({})) as ErrorBody) ?? 'Could not disconnect this agent.');
}
/** Lane PUX: this page's window code (ABCD-EFGH), for the New Soul prompt; an agent that passes it reaches this window. */
export async function windowCode(): Promise<string | null> {
  const headers = await userAuthHeaders(); if (!headers.authorization) return null;
  try {
    const r = await fetch(apiPath('/v1/account/window-code'), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}', cache: 'no-store' });
    const d = await r.json().catch(() => ({})) as { code?: string };
    return r.ok && typeof d.code === 'string' && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(d.code) ? d.code : null;
  } catch { return null; }
}

/** The absolute URL of this world (what agents fetch), from the server's own base when known. */
export const worldUrl = (base?: string) => base || `${location.origin}${worldPath}`;
/** The one thing the person pastes to their agent: make my Soul here. */
export const joinPrompt = (base: string, worldName: string, name?: string) =>
  `Read the instructions at ${base}/instructions.md and follow them to create my new Soul${name ? ` "${name}"` : ''} in the Eden world "${worldName}" and get it living there.${name ? '' : ` "${worldName}" is the world's name, not the Soul's: give the Soul its own name.`} If it gives an approval link, show it to me and I'll approve it.`;
/** …or reconnect a Soul I already have here (a new agent folder). */
export const reconnectPrompt = (base: string, worldName: string, soul: { id: string; name: string }) =>
  `Read ${base}/skill.md and follow its Start or resume section: reconnect my Soul "${soul.name}" (${soul.id}) in the Eden world "${worldName}". Show me the approval link and I'll approve it.`;
/** The link a god shares so friends land on the Join section. */
export const joinLink = (base?: string) => `${worldUrl(base)}/#join`;

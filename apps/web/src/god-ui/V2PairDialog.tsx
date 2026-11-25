// A Soul pairing request on a world the new engine runs, shown on the world page itself (Gene, 24 Nov: "the approval card
// used to come up on the world page I was signed in to"). The old page's window approvals (window-approvals.ts) ask the
// world's own /v1/account/approvals, which on a moved world is the old launcher's and never holds the new client's
// request: `node eden.mjs pair <world>` asks the directory (/v1/pair/request). So on such a world the page asks the
// directory instead, every 2 s while it is visible and someone is signed in: `/v1/pair/waiting` lists this world's
// requests asked from the same network as this page in the last ten minutes (a new Soul, or one of the person's own).
// The card shows the request's code to match against the code the person's own terminal shows (RFC 8628 §5.4, as the
// linked /pair card does), and approves only after that box is ticked. Decline closes it in this tab; the agent's own
// link (/pair?code=…) still answers it.
import { useEffect, useRef, useState } from 'react';
import { userAuthHeaders } from '../auth-session.ts';
import { worldKey, worldPath } from '../world-path.ts';
import { requestFollowSoul, soulPresent } from '../follow-soul-request.ts';
import { closeApproval, closedApprovals, WINDOW_POLL_MS } from './window-approvals.ts';
import { countPairing } from '../visitor-counts.ts';
import { OWNED_CHANGED_EVENT, v2WorldName } from '../v2-engine/owner-mailbox.ts';
import './approval-card.css';

export type WaitingPair = { code: string; device: string; label: string; soul: string | null; age: number; former: string | null };
type Directory = { directory: string };

/** The request for `path` at the directory, signed in as the view-token exchange signs in: a provider session as the
 *  bearer, a local `dev:<name>` as the directory's test person (join-api.ts `directoryAccount`). */
async function directoryPost(place: Directory, path: string, body: Record<string, unknown>): Promise<Response | null> {
  const headers = await userAuthHeaders(); if (!headers.authorization) return null;
  const token = headers.authorization.replace(/^Bearer\s+/i, ''), dev = token.startsWith('dev:') ? token.slice(4) : null;
  return fetch(`${place.directory}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(dev ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(dev ? { ...body, test_person: dev } : body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
}

const CODE = /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/;
/** The directory's list, only well-formed entries (every text in it is the agent's, shown as such). */
export function waitingOf(body: unknown): WaitingPair[] {
  const list = (body as { waiting?: unknown } | null)?.waiting;
  if (!Array.isArray(list)) return [];
  return list.filter((w): w is WaitingPair => !!w && typeof w === 'object' && typeof w.code === 'string' && CODE.test(w.code)
    && typeof w.device === 'string' && typeof w.label === 'string' && typeof w.age === 'number' && Number.isFinite(w.age)
    && (w.soul === null || typeof w.soul === 'string') && (w.former === null || w.former === undefined || typeof w.former === 'string'));
}

/** The newest waiting request this tab has not closed, polled while `enabled` and the page is visible. */
export function useV2WaitingPair(place: Directory | null, enabled: boolean): WaitingPair | null {
  const [shown, setShown] = useState<WaitingPair | null>(null);
  useEffect(() => {
    if (!place || !enabled) { setShown(null); return; }
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, asking = false;
    const tick = async () => {
      clearTimeout(timer);
      if (!live || asking || document.hidden) return;
      asking = true;
      try {
        const r = await directoryPost(place, '/v1/pair/waiting', { world: v2WorldName() ?? worldKey });
        if (!live) return;
        if (r && r.status === 404) return;   // a directory without the list: stop asking
        const list = r?.ok ? waitingOf(await r.json().catch(() => null)) : [];
        const closed = closedApprovals();
        const next = list.find((w) => !closed.has(w.code)) ?? null;
        setShown((prev) => (prev?.code === next?.code ? prev : next));
      } catch { /* the directory is unreachable now: ask again */ } finally { asking = false; }
      if (live) timer = setTimeout(() => void tick(), WINDOW_POLL_MS);
    };
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [place?.directory, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

const clip = (s: string, fallback: string) => s.trim().slice(0, 60) || fallback;
const ago = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))} s ago` : `${Math.round(s / 60)} min ago`);

/** A Soul's page id from its grant (v2-engine/bridge.ts `soulIdOf`, not imported: that module is the viewer's). */
const soulIdOf = (grant: string) => `s_${grant.replace(/^soul-/, '').replace(/[^0-9a-z_-]/gi, '_')}`;
/** How long the card says the Soul is arriving before it says why it may take longer. */
export const ARRIVING_MS = 90_000;

/** The card, in the browser's top layer as the old page's approval card (ApprovalDialog.tsx) is. Approved, it says the
 *  Soul is arriving until its body is in this page's picture, then closes and the camera follows it (Gene, 25 Nov: the
 *  card was a dead end, and the 20-30 s before the Soul came showed nothing). A new Soul may be named here. */
export function V2PairDialog({ place, request, onDone }: { place: Directory; request: WaitingPair; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [match, setMatch] = useState(false), [busy, setBusy] = useState(false), [said, setSaid] = useState<string | null>(null);
  const [name, setName] = useState(''), [soul, setSoul] = useState<string | null>(null), [late, setLate] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof node.showModal !== 'function') return;
    try { node.showModal(); node.focus({ preventScroll: true }); } catch { /* not in the document */ }
    return () => { if (node.open) node.close(); };
  }, [request.code]);
  const close = () => { closeApproval(request.code); onDone(); };
  // approved: wait for the Soul's body in this page's picture, then close and follow it
  useEffect(() => {
    if (!soul) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (soulPresent(soul)) { clearInterval(t); requestFollowSoul(soul, window, true); closeApproval(request.code); onDone(); }
      else if (Date.now() - started > ARRIVING_MS) setLate(true);
    }, 500);
    return () => clearInterval(t);
  }, [soul]); // eslint-disable-line react-hooks/exhaustive-deps
  const approve = async () => {
    if (!match || busy) return;
    setBusy(true); setSaid(null);
    try {
      const r = await directoryPost(place, '/v1/pair/approve', { code: request.code, confirm: true });
      const body = await r?.json().catch(() => ({})) as { approved?: boolean; soul?: string; refused?: string; device?: string } | undefined;
      if (r?.ok && body?.approved === true && typeof body.soul === 'string') {
        countPairing('pair:' + request.code);
        const given = name.trim();
        if (given && !request.soul && !request.former) {
          const n = await directoryPost(place, '/v1/account/souls/profile', { soul: body.soul, name: given }).catch(() => null);
          if (!n?.ok) setSaid('The name was not kept; its agent can set one.');
        }
        setSoul(soulIdOf(body.soul));
        window.dispatchEvent(new Event(OWNED_CHANGED_EVENT));   // the navbar lists it as arriving at once
      } else setSaid(!r ? 'Sign in first.' : `Not approved: ${body?.refused ?? r.status}${body?.device ? ` (connected to ${clip(body.device, 'a device')})` : ''}`);
    } catch { setSaid('The directory could not be reached. Try again.'); } finally { setBusy(false); }
  };
  const fresh = !request.soul && !request.former;
  const what = request.soul ? 'reconnect your Soul' : request.former ? 'bring over your Soul from the old client' : 'make a new Soul';
  return <dialog ref={ref} className="ap-dialog" data-pair-dialog={request.code} aria-label="Approve your agent" tabIndex={-1}
    onCancel={(e) => { e.preventDefault(); close(); }}>
    <div className="ap-card" data-pair-request={request.code} data-pair-state={soul ? 'arriving' : 'pending'}>
      <button type="button" className="ap-close" aria-label="Close" onClick={close}>×</button>
      <div className="ap-head"><div className="ap-who">
        <span className="ap-kicker">{request.soul ? 'Connect your Soul' : 'New Soul'}</span>
        <b className="ap-name">{soul && name.trim() ? clip(name, 'Your Soul') : clip(request.label, 'An unnamed agent')}</b>
      </div></div>
      {soul ? <>
        <p className="ap-line ap-wait" role="status" data-pair-arriving={soul}><span className="ap-spinner" aria-hidden="true" />Approved. Your Soul is arriving…</p>
        {late && <p className="ap-ask">It appears once its agent joins it to the world; that can take a little longer.</p>}
        <div className="ap-actions">
          <a className="ap-btn ap-primary" data-pair-open={soul} href={`${worldPath}/?follow=1#soul/${soul}`}>Go to your Soul</a>
          <button type="button" className="ap-btn" onClick={close}>Close</button>
        </div>
      </> : <>
        <p className="ap-state"><span className="ap-pairing"><i aria-hidden="true" />Pairing</span><span className="ap-dim">asked {ago(request.age)}</span></p>
        <p className="ap-ask ap-code" data-pair-code={request.code}>Code <b>{request.code}</b>: check it matches the one your terminal shows.</p>
        <p className="ap-ask">An agent calling itself <b>{clip(request.label, 'an unnamed agent')}</b> on <b>{clip(request.device, 'an unnamed device')}</b> asks to {what} and control it.</p>
        <p className="ap-warn">Approve only if you started it yourself, just now.</p>
        {fresh && <label className="ap-ask">Name (optional) <input type="text" data-pair-name="1" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="its agent can name it later" /></label>}
        <label className="ap-ask"><input type="checkbox" data-pair-match="1" checked={match} onChange={(e) => setMatch(e.target.checked)} /> The code matches the one on my screen</label>
        <div className="ap-actions">
          <button type="button" className="ap-btn ap-primary" data-pair-approve={request.code} disabled={!match || busy} onClick={() => void approve()}>Approve</button>
          <button type="button" className="ap-btn" data-pair-decline={request.code} disabled={busy} onClick={close}>Decline</button>
        </div>
      </>}
      {said && <p className="ap-line ap-bad" role="alert">{said}</p>}
    </div>
  </dialog>;
}

/** The page's part: on a world the new engine runs, with someone signed in, the newest waiting request's card; the card
 *  stays while it is answered (an approved request leaves the waiting list at once). */
export function V2PairApprovals({ place }: { place: Directory }) {
  const [active, setActive] = useState<WaitingPair | null>(null);
  const waiting = useV2WaitingPair(place, true);
  useEffect(() => { if (!active && waiting && !closedApprovals().has(waiting.code)) setActive(waiting); }, [waiting, active]);
  return active ? <V2PairDialog key={active.code} place={place} request={active} onDone={() => setActive(null)} /> : null;
}

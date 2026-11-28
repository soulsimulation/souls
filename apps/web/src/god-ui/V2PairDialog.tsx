// A Soul pairing request on a world the new engine runs, shown on the world page itself (Gene, 24 Nov: "the approval card
// used to come up on the world page I was signed in to"). The old page's window approvals (window-approvals.ts) ask the
// world's own /v1/account/approvals, which on a moved world is the old launcher's and never holds the new client's
// request: `node eden.mjs pair <world>` asks the directory (/v1/pair/request). So on such a world the page asks the
// directory instead, every 2 s while it is visible and someone is signed in: `/v1/pair/waiting` lists this world's
// requests asked from the same network as this page in the last ten minutes (a new Soul, or one of the person's own).
// The card shows the request's code to match against the code the person's own terminal shows (RFC 8628 §5.4, as the
// linked /pair card does), and approves only after that box is ticked. Decline closes it in this tab; the agent's own
// link (/pair?code=…) still answers it. #5006: the request of this world's creator's agent (`souls-god.mjs pair <world>
// --creator <grant>`) comes up the same way, for the world's owner alone: the directory lists it only to the account
// holding the grant, and this page only when the grant is its own world's.
import { useEffect, useRef, useState } from 'react';
import { userAuthHeaders } from '../auth-session.ts';
import { worldKey, worldPath } from '../world-path.ts';
import { requestFollowSoul, soulPresent } from '../follow-soul-request.ts';
import { closeApproval, closedApprovals, WINDOW_POLL_MS } from './window-approvals.ts';
import { countPairing } from '../visitor-counts.ts';
import { v2Approved, v2WorldName } from '../v2-engine/owner-mailbox.ts';
import { v2Creator } from './god-api.ts';
import { nameRefusedLine } from './pair-name.ts';
import './approval-card.css';

/** `name`: the name a new Soul's agent asked for (`souls.mjs pair --name`), when it asked for one. */
export type WaitingPair = { code: string; device: string; label: string; soul: string | null; age: number; former: string | null; name?: string | null };
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
    && (w.soul === null || typeof w.soul === 'string') && (w.former === null || w.former === undefined || typeof w.former === 'string')
    && (w.name === null || w.name === undefined || typeof w.name === 'string'));
}

/** A request of a world's creator's agent: its grant is a creator grant (directoryd `is_creator_grant`). */
export const isCreatorRequest = (w: WaitingPair) => !!w.soul && /^creator-[0-9a-f]{32}-\d+$/.test(w.soul);
/** The request to show: the newest not closed in this tab, a creator's only when its grant is this world's creator grant
 *  (`creator`, the signed-in owner's; null for anyone else). */
export function nextWaiting(list: readonly WaitingPair[], closed: ReadonlySet<string>, creator: string | null): WaitingPair | null {
  return list.find((w) => !closed.has(w.code) && (!isCreatorRequest(w) || (!!creator && w.soul === creator))) ?? null;
}

/** The newest waiting request this tab has not closed, polled while `enabled` and the page is visible. */
export function useV2WaitingPair(place: Directory | null, enabled: boolean, creator: string | null = null): WaitingPair | null {
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
        const next = nextWaiting(list, closedApprovals(), creator);
        setShown((prev) => (prev?.code === next?.code ? prev : next));
      } catch { /* the directory is unreachable now: ask again */ } finally { asking = false; }
      if (live) timer = setTimeout(() => void tick(), WINDOW_POLL_MS);
    };
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [place?.directory, enabled, creator]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

const clip = (s: string, fallback: string) => s.trim().slice(0, 60) || fallback;
/** The agent as its client names itself ("Claude Code on this computer"); an older client's script name ("souls.mjs",
 *  "agent") reads as "An agent". The device's name is never shown: it is the computer's host name (first day, 25 Nov). */
export const agentWords = (label: string) => (/^(agent|[\w.-]+\.m?js)$/i.test(label.trim()) ? 'An agent' : clip(label, 'An agent'));
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
  // trial of 0.137: the Name field starts with the name the agent asked for
  const asked = request.soul || request.former ? '' : (request.name ?? '').trim().slice(0, 40);
  const [name, setName] = useState(asked), [soul, setSoul] = useState<string | null>(null), [late, setLate] = useState(false);
  const creator = isCreatorRequest(request), [built, setBuilt] = useState(false);
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
      if (r?.ok && body?.approved === true && creator) setBuilt(true);   // no Soul to wait for: the agent builds
      else if (r?.ok && body?.approved === true && typeof body.soul === 'string') {
        countPairing('pair:' + request.code);
        setSoul(soulIdOf(body.soul));
        v2Approved(soulIdOf(body.soul));   // the navbar lists it as arriving at once; its card's box starts now
        // the name the person gave: written beside the arrival, never before it (first day, 28 Nov)
        const given = name.trim();
        if (given && !request.soul && !request.former) {
          void directoryPost(place, '/v1/account/souls/profile', { soul: body.soul, name: given })
            .then(async (n) => { if (n?.ok) return; const why = await n?.json().catch(() => null) as { refused?: string } | null | undefined; setSaid(nameRefusedLine(why?.refused)); })
            .catch(() => setSaid(nameRefusedLine(null)));
        }
      } else setSaid(!r ? 'Sign in first.' : `Not approved: ${body?.refused ?? r.status}${body?.device ? ` (connected to ${clip(body.device, 'a device')})` : ''}`);
    } catch { setSaid('The directory could not be reached. Try again.'); } finally { setBusy(false); }
  };
  const fresh = !request.soul && !request.former;
  const what = creator ? 'build this world as its creator: place, change and remove things in it' : request.soul ? 'reconnect your Soul and control it' : request.former ? 'bring over your Soul from the old client and control it' : 'make a new Soul and control it';
  return <dialog ref={ref} className="ap-dialog" data-pair-dialog={request.code} aria-label="Approve your agent" tabIndex={-1}
    onCancel={(e) => { e.preventDefault(); close(); }}>
    <div className="ap-card" data-pair-request={request.code} data-pair-scope={creator ? 'creator' : 'soul'} data-pair-state={built ? 'approved' : soul ? 'arriving' : 'pending'}>
      <button type="button" className="ap-close" aria-label="Close" onClick={close}>×</button>
      <div className="ap-head"><div className="ap-who">
        <span className="ap-kicker">{creator ? 'Connect your agent' : request.soul ? 'Connect your Soul' : 'New Soul'}</span>
        <b className="ap-name">{(soul || asked) && name.trim() ? clip(name, 'Your Soul') : agentWords(request.label)}</b>
      </div></div>
      {built ? <>
        <p className="ap-line" role="status" data-pair-approved="creator">Approved. Your agent can build this world once it connects; the command box in God Mode then opens.</p>
        <div className="ap-actions"><button type="button" className="ap-btn ap-primary" onClick={close}>Close</button></div>
      </> : soul ? <>
        <p className="ap-line ap-wait" role="status" data-pair-arriving={soul}><span className="ap-spinner" aria-hidden="true" />Approved. Your Soul is arriving…</p>
        {late && <p className="ap-ask">It appears once its agent joins it to the world; that can take a little longer.</p>}
        <div className="ap-actions">
          <a className="ap-btn ap-primary" data-pair-open={soul} href={`${worldPath}/?follow=1#soul/${soul}`}>Go to your Soul</a>
          <button type="button" className="ap-btn" onClick={close}>Close</button>
        </div>
      </> : <>
        <p className="ap-state"><span className="ap-pairing"><i aria-hidden="true" />Pairing</span><span className="ap-dim">asked {ago(request.age)}</span></p>
        <p className="ap-ask ap-code" data-pair-code={request.code}>Code <b>{request.code}</b>: check it matches the one your terminal shows.</p>
        <p className="ap-ask"><b>{agentWords(request.label)}</b> asks to {what}.</p>
        <p className="ap-warn">Approve only if you started it yourself, just now.</p>
        {fresh && <label className="ap-ask">Name (optional) <input type="text" data-pair-name="1" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="its agent can name it later" /></label>}
        <label className="ap-ask ap-check"><input type="checkbox" data-pair-match="1" checked={match} onChange={(e) => setMatch(e.target.checked)} /> The code matches the one on my screen</label>
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
  // the world's creator grant, when the signed-in person is its creator: its agent's request shows here too (#5006)
  const [creator, setCreator] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void v2Creator()?.then((c) => c.who()).then((w) => { if (live && w.creator) setCreator(w.grant); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const waiting = useV2WaitingPair(place, true, creator);
  useEffect(() => { if (!active && waiting && !closedApprovals().has(waiting.code)) setActive(waiting); }, [waiting, active]);
  return active ? <V2PairDialog key={active.code} place={place} request={active} onDone={() => setActive(null)} /> : null;
}

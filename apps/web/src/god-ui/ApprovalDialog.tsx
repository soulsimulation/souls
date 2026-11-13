// An agent asks to make (or reconnect) the signed-in person's Soul: this card answers it.
// Lane HF (Gene 2026-10-20): a modal dialog in the browser's top layer, above every z-index, from the first render until it
// is answered or closed; when another dialog opens (God Mode, Explore, the account menu) this one is lifted back over it.
// Lane PUX (Gene 2026-10-20b): the same guarantee, drawn as a small frosted card in the top right like the other menus,
// with the Soul's picture (or a generic one), short copy, the agent's self-chosen name only behind an (i), and Ask again
// once a request timed out. Gene 2026-10-20c: after Approve it says "<Name> is being prepared by your agent. Please
// wait…" with a spinner; when the Soul's body is in the world the card closes itself and the camera follows the new Soul
// (follow-soul-request.ts -> the Shell's viewer). A refused body is one short line and Close. It opens from the agent's
// link (#approve/<id>, older agents) or, with no navigation at all, in the window that gave the agent its window code.
// LINK (spec SOUL-LINK §4, 2026-10-24): the card *is* the Pairing state of the Soul card: kicker, `● Pairing · asked …`,
// "An agent calling itself <label> asks to control <name>", one warning line, Approve / Refuse, nothing else. While a Soul
// card is open it is drawn inside that card (`embedded`, pairing-slot.ts), never as a second dialog over it.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as J from './join-api.ts';
import { approvalLine, preparingLine, requestLine, safePhoto, staleRequestNote } from './window-approvals.ts';
import { requestFollowSoul } from '../follow-soul-request.ts';
import { countPairing, pairingTaken } from '../visitor-counts.ts';
import { approvalTitle, isAccountRequest } from '../approval-link.ts';
import { ageText } from '../soul-state.ts';
import './approval-card.css';

const AVATAR = <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="15" r="7" fill="currentColor" opacity=".55" /><path d="M6 36a14 14 0 0 1 28 0" fill="currentColor" opacity=".55" /></svg>;

/** The agent's self-chosen label, clipped: it is untrusted text, shown as what the agent calls itself. */
const agentName = (label: string | undefined) => (label ?? '').trim().slice(0, 60) || 'an unnamed agent';
const askedAt = (a: J.Approval) => { const t = (a as { createdAt?: unknown }).createdAt; return typeof t === 'number' && Number.isFinite(t) ? t : null; };

type CardProps = { id: string; signedIn: boolean; signIn?: ReactNode; onDone: () => void; embedded?: boolean };
/** #2245: an `aq_` id is an account request (a login or a retire), anything else a Soul approval. The Soul card's hooks run
 *  in this component itself (as before #2245: account-approval-lifecycle.test.mjs renders it with its own hook
 *  dispatcher); every caller keys the card by its id, so one instance never switches between the two. */
export function ApprovalCard(props: CardProps) {
  return isAccountRequest(props.id) ? <RequestCard {...props} /> : SoulApprovalCard(props);
}

function SoulApprovalCard({ id, signedIn, signIn, onDone, embedded = false }: CardProps) {
  const [a, setA] = useState<J.Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refusedHere, setRefusedHere] = useState(false);
  const [approving, setApproving] = useState(false);
  const pressed = useRef(false);   // Approve was pressed in this card: only this card counts the pairing
  const check = useCallback(async (action?: 'approve' | 'cancel' | 'renew') => {
    if (action) setBusy(true);
    if (action === 'approve') { setApproving(true); pressed.current = true; }
    setErr(null);
    try { const next = await J.approval(id, action); setA(next); if (action === 'cancel' && next.status === 'cancelled') setRefusedHere(true); }
    catch (e) { setErr((e as Error).message); if (action === 'approve') setApproving(false); }
    finally { if (action) setBusy(false); }
  }, [id]);
  useEffect(() => { if (signedIn) void check(); }, [signedIn, check]);
  // follow the request while it can still change on its own (the agent withdraws it, it times out, the body arrives)
  const live = a?.status === 'pending' || a?.status === 'creating';
  useEffect(() => { if (!live) return; const t = setInterval(() => void check(), a?.status === 'creating' ? 2000 : 4000); return () => clearInterval(t); }, [live, a?.status, check]);
  const done = useRef(onDone); done.current = onDone;   // the parent re-renders often; closing must happen once
  const closed = useRef(false);
  // GoatCounter "soul paired", once per approval (visitor-counts.ts): when the server took this card's Approve, even if the
  // card is closed before the body is ready; another window's approval seen turning ready here is not counted again
  useEffect(() => { if (pairingTaken(pressed.current, a?.status)) countPairing(id); }, [a?.status, id]);
  useEffect(() => {
    if (a?.status !== 'ready' || closed.current) return;
    closed.current = true;
    if (a.soulId) requestFollowSoul(a.soulId);
    done.current();
  }, [a?.status, a?.soulId]);
  const photo = safePhoto(a?.photo);
  const line = approvalLine(a, refusedHere);
  // from the Approve press until the body is ready (or refused): the spinner line, nothing else to press
  const preparing = a?.status === 'creating' || (approving && a?.status === 'pending');
  const kicker = a?.mode === 'repair' ? 'Connect your Soul' : 'New Soul';
  const title = approvalTitle(a) ?? (signedIn ? '…' : 'Your agent is asking');
  const asked = a ? askedAt(a) : null;
  return (
    <div className={'ap-card' + (embedded ? ' ap-embedded' : '')} data-approval={id} data-approval-status={a?.status ?? ''}>
      {!embedded && <button type="button" className="ap-close" data-approval-close="1" aria-label="Close" onClick={onDone}>×</button>}
      <div className="ap-head">
        {photo ? <img className="ap-avatar" src={photo} alt="" /> : <span className="ap-avatar ap-generic">{AVATAR}</span>}
        <div className="ap-who">
          <span className="ap-kicker">{kicker}</span>
          <b className="ap-name" data-approval-name="1" title={title}>{title}</b>
        </div>
      </div>
      {a?.status === 'pending' && !preparing && <>
        <p className="ap-state"><span className="ap-pairing"><i aria-hidden="true" />Pairing</span><span className="ap-dim">{asked ? `asked ${ageText(asked)}` : 'waiting for your answer'}</span></p>
        <p className="ap-ask" data-approval-copy="1"><span data-approval-note="1">An agent calling itself <b>{agentName(a.agentLabel)}</b></span> {a.mode === 'repair' ? <>asks to control {approvalTitle(a) ?? 'your Soul'}.</> : <>asks to make a new Soul, {approvalTitle(a) ?? 'unnamed'}, and control it.</>}</p>
        <p className="ap-warn">Approve only if you started it yourself.{a.mode === 'repair' ? ' The agent connected now, if any, is disconnected.' : ''}</p>
      </>}
      {!signedIn && <><p className="ap-line">Sign in to answer.</p>{signIn && <div className="ap-signin">{signIn}</div>}</>}
      {preparing && a && <p className="ap-line ap-wait" role="status" data-approval-preparing="1"><span className="ap-spinner" aria-hidden="true" />{preparingLine({ ...a, name: approvalTitle(a) ?? a.name })}</p>}
      {a?.status === 'pending' && !preparing && <div className="ap-actions">
        <button type="button" className="ap-btn ap-primary" data-approve-agent={id} disabled={busy} onClick={() => void check('approve')}>Approve</button>
        <button type="button" className="ap-btn" data-refuse-agent={id} disabled={busy} onClick={() => void check('cancel')}>Refuse</button>
      </div>}
      {line && <p className={'ap-line' + (a?.status === 'refused' ? ' ap-bad' : '')}
        role={a?.status === 'refused' ? 'alert' : 'status'} {...(a?.status === 'refused' ? { 'data-approval-reason': a.reason?.code ?? 'refused' } : {})}>{line}</p>}
      {(a?.status === 'refused' || a?.status === 'cancelled') && <div className="ap-actions">
        <button type="button" className="ap-btn" data-approval-done={id} onClick={onDone}>Close</button>
      </div>}
      {a?.status === 'expired' && <div className="ap-actions">
        <button type="button" className="ap-btn ap-primary" data-approval-renew={id} disabled={busy} onClick={() => void check('renew')}>Ask again</button>
      </div>}
      {err && <p className="ap-line ap-bad">{err}</p>}
    </div>
  );
}

/** The agent's device name, clipped like its label: untrusted text. */
const deviceName = (q: J.AccountRequest) => q.device.name.trim().slice(0, 60) || 'an unnamed device';
/** #2245 (`account-grant/1`): an agent asks to log in to this account, or to retire one of its Souls. Same card, its own copy;
 *  Approve (Retire) and Refuse answer the request and the card closes. */
function RequestCard({ id, signedIn, signIn, onDone, embedded = false }: CardProps) {
  const [q, setQ] = useState<J.AccountRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = useRef(false);   // this card approved or refused it: close, with nothing more to say
  const check = useCallback(async (action?: 'approve' | 'cancel') => {
    if (action) { setBusy(true); answered.current = true; }
    setErr(null);
    try { setQ(await J.accountRequest(id, action)); }
    catch (e) { setErr((e as Error).message); answered.current = false; }
    finally { if (action) setBusy(false); }
  }, [id]);
  useEffect(() => { if (signedIn) void check(); }, [signedIn, check]);
  const pending = q?.status === 'pending';
  useEffect(() => { if (!pending) return; const t = setInterval(() => void check(), 4000); return () => clearInterval(t); }, [pending, check]);
  const done = useRef(onDone); done.current = onDone;
  const closed = useRef(false);
  useEffect(() => {
    if (closed.current || !q || !(q.status === 'ready' || (q.status === 'cancelled' && answered.current))) return;
    closed.current = true; done.current();
  }, [q]);
  const title = q ? (q.kind === 'retire' ? q.soul?.name ?? 'Your Soul' : deviceName(q)) : signedIn ? '…' : 'Your agent is asking';
  const line = requestLine(q), stale = q ? staleRequestNote(q) : null;
  return (
    <div className={'ap-card' + (embedded ? ' ap-embedded' : '')} data-approval={id} data-approval-status={q?.status ?? ''} data-request-kind={q?.kind ?? ''}>
      {!embedded && <button type="button" className="ap-close" data-approval-close="1" aria-label="Close" onClick={onDone}>×</button>}
      <div className="ap-head">
        <span className="ap-avatar ap-generic">{AVATAR}</span>
        <div className="ap-who">
          <span className="ap-kicker">{q?.kind === 'retire' ? 'Retire a Soul' : 'Connect your account'}</span>
          <b className="ap-name" data-approval-name="1" title={title}>{title}</b>
        </div>
      </div>
      {pending && q && <>
        <p className="ap-state"><span className="ap-pairing"><i aria-hidden="true" />{q.kind === 'login' ? 'Login' : 'Retire'}</span><span className="ap-dim" data-request-age={q.createdAt}>{`asked ${ageText(q.createdAt)}`}</span></p>
        <p className="ap-ask ap-code" data-request-confirm={q.confirm}>Code <b>{q.confirm}</b>: check it matches the one your agent shows.</p>
        {q.kind === 'login' ? <>
          <p className="ap-ask" data-approval-copy="1">An agent calling itself <b>{agentName(q.agentLabel)}</b> on <b>{deviceName(q)}</b> asks to connect to your account.</p>
          <p className="ap-ask">It will be able to see your Souls on this site, reconnect or disconnect them, and ask you to retire one.</p>
          <p className="ap-warn">Approve only if you started it yourself.</p>
        </> : <>
          <p className="ap-ask" data-approval-copy="1">An agent calling itself <b>{agentName(q.agentLabel)}</b> on <b>{deviceName(q)}</b> asks to retire <b>{q.soul?.name ?? 'your Soul'}</b>.</p>
          <p className="ap-warn">A retired Soul leaves the world for good and cannot come back.</p>
        </>}
      </>}
      {!signedIn && <><p className="ap-line">Sign in to answer.</p>{signIn && <div className="ap-signin">{signIn}</div>}</>}
      {pending && stale && <p className="ap-warn" data-request-stale="1">{stale}</p>}
      {pending && q && <div className="ap-actions">
        <button type="button" className={'ap-btn ' + (q.kind === 'retire' ? 'ap-danger' : 'ap-primary')} data-approve-agent={id} disabled={busy} onClick={() => void check('approve')}>{q.kind === 'retire' ? 'Retire' : 'Approve'}</button>
        <button type="button" className="ap-btn" data-refuse-agent={id} disabled={busy} onClick={() => void check('cancel')}>Refuse</button>
      </div>}
      {line && !answered.current && <><p className="ap-line" role="status">{line}</p>
        <div className="ap-actions"><button type="button" className="ap-btn" data-approval-done={id} onClick={onDone}>Close</button></div></>}
      {err && <p className="ap-line ap-bad">{err}</p>}
    </div>
  );
}
export function ApprovalDialog({ id, signedIn, signIn, onDone }: { id: string; signedIn: boolean; signIn?: ReactNode; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof node.showModal !== 'function') return;
    const raise = () => { if (!node.isConnected) return; try { if (node.open) node.close(); node.showModal(); node.focus({ preventScroll: true }); } catch { /* not in the document */ } };
    raise();
    const others = new MutationObserver((records) => {
      if (records.some((r) => r.target !== node && r.target instanceof HTMLDialogElement && r.target.open)) raise();
    });
    others.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('fullscreenchange', raise);
    return () => { others.disconnect(); document.removeEventListener('fullscreenchange', raise); if (node.open) node.close(); };
  }, [id]);
  // Escape is the person closing it, as the card's own × is; the request stays pending for the agent. Focus starts on the
  // dialog itself, not on a button (Enter must not approve, refuse or close by accident)
  return <dialog ref={ref} className="ap-dialog" data-approval-dialog={id} aria-label="Approve your agent" tabIndex={-1}
    onCancel={(e) => { e.preventDefault(); onDone(); }}>
    <ApprovalCard key={id} id={id} signedIn={signedIn} signIn={signIn} onDone={onDone} />
  </dialog>;
}

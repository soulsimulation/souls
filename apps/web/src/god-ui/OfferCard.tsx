// The two links the launcher's handoff (tools/world-launcher/handoff.mjs) sends people to on a world page:
//   #worldoffer/<code>   an owner's invitation: become a co-builder, or take the world over. Accepting, signed in, is the consent.
//   #cobuildpair/<code>  a co-builder's own agent asks for a god token on this world; the co-builder approves it.
// On a world the new engine runs the creator's handoff link is the same #worldoffer/<code>, made by the world's directory
// (v2-forsake.ts, #5006): accepting asks the directory, signed in; there are no co-builders there (one creator per world).
import { useEffect, useState } from 'react';
import { BASE } from '../base-path.ts';
import { worldKey } from '../world-path.ts';
import { userAuthHeaders } from '../auth-session.ts';
import { acceptHandoff, forsakeHere } from './v2-forsake.ts';
import { v2PageWorldName } from '../v2-engine/owner-mailbox.ts';
import { worldTitle } from '../world-title.ts';

export type OfferLink = { kind: 'worldoffer' | 'cobuildpair'; code: string };
export const offerFromHash = (hash: string): OfferLink | null => {
  const m = /^#(worldoffer|cobuildpair)\/([A-Za-z0-9_-]{4,64})$/.exec(hash);
  return m ? { kind: m[1] as OfferLink['kind'], code: m[2] } : null;
};
const at = (sub: string) => `${BASE}/__sim/worlds/${worldKey}/${sub}`;
async function send(sub: string, body: unknown) {
  const r = await fetch(at(sub), { method: 'POST', headers: { 'content-type': 'application/json', ...(await userAuthHeaders()) }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message ?? d.code ?? `HTTP ${r.status}`);
  return d;
}

type Offer = { kind: 'cobuild' | 'transfer'; world: { name: string } } | 'gone' | 'off' | null;
export function OfferCard({ link, signedIn, onDone, here = forsakeHere() }: { link: OfferLink; signedIn: boolean; onDone: () => void; here?: ReturnType<typeof forsakeHere> }) {
  // a world the new engine runs: the directory holds the offer, and has no read of it before acceptance
  const [offer, setOffer] = useState<Offer>(() => (!here ? null : link.kind === 'worldoffer' ? { kind: 'transfer', world: { name: worldTitle(v2PageWorldName(), here.world) } } : 'off'));
  const [state, setState] = useState<{ busy?: boolean; done?: string; err?: string }>({});
  useEffect(() => {
    if (link.kind !== 'worldoffer' || here) return;
    // a co-builder invitation while co-builders are off (one god per world): the launcher says so (code cobuilders-off)
    void fetch(`${at('offer')}?code=${encodeURIComponent(link.code)}`).then(async (r) => (r.ok ? r.json() : (await r.json().catch(() => ({}))).code === 'cobuilders-off' ? 'off' : 'gone')).then(setOffer, () => setOffer('gone'));
  }, [link]);
  const act = async () => {
    setState({ busy: true });
    try {
      if (here) { await acceptHandoff(here.place, here.world, link.code); setState({ done: 'This world is yours now. Reload to open God Mode.' }); }
      else if (link.kind === 'cobuildpair') { const d = await send('cobuild/pair/approve', { code: link.code }); setState({ done: `Approved. ${d.agent} now builds here as your co-builder agent; it finishes on its own.` }); }
      else { const d = await send('offer/accept', { code: link.code }); setState({ done: d.kind === 'transfer' ? 'This world is yours now. Reload to open God mode.' : 'You are a co-builder now. Ask your agent to pair with this world as a co-builder.' }); }
    } catch (e) { setState({ err: (e as Error).message }); }
  };
  const title = offer === 'off' ? 'Co-builders are turned off'
    : link.kind === 'cobuildpair' ? 'Your agent asks to co-build this world'
      : offer === 'gone' ? 'This invitation is no longer valid'
      : offer?.kind === 'transfer' ? `You are offered ${offer.world.name}` : offer ? `You are invited to co-build ${offer.world.name}` : 'Invitation…';
  const what = offer === 'off' ? 'Each world has one god, its owner, so this co-builder invitation cannot be used.'
    : link.kind === 'cobuildpair' ? 'It gets its own god token for this world, labelled with your name. The owner can revoke it.'
    : offer && offer !== 'gone' ? (offer.kind === 'transfer' ? `Accept and you become its ${here ? 'creator' : 'god'}: its owner hands it to you, and every agent that could edit it loses that access.${here ? ' Its Souls and everything built stay as they are.' : ''}` : 'Accept and your own agent can build here alongside the owner. You cannot hand the world on or archive it.') : null;
  return (
    <div className="gp-pairs" data-offer={link.kind} data-offer-kind={offer && offer !== 'gone' && offer !== 'off' ? offer.kind : offer ?? ''}>
      <b>{title}</b>
      {what && <p className="gp-dim">{what}</p>}
      {!signedIn && offer !== 'gone' && offer !== 'off' && <p>Sign in first; accepting with your account is your consent.</p>}
      {signedIn && !state.done && offer !== 'gone' && offer !== 'off' && (link.kind === 'cobuildpair' || offer) && (
        <div className="gp-row"><button className="gp-btn gp-primary" data-offer-accept="1" disabled={state.busy} onClick={() => void act()}>{link.kind === 'cobuildpair' ? 'Approve my agent' : 'Accept'}</button><button className="gp-btn" onClick={onDone}>Not now</button></div>
      )}
      {state.done && <p role="status" className="gp-ok">{state.done}</p>}
      {state.err && <p className="gp-bad">{state.err}</p>}
      <div className="gp-row"><span /><button className="gp-mini" onClick={onDone}>close</button></div>
    </div>
  );
}

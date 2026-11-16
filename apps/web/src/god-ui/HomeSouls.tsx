// #2466: the homepage's My Souls: the signed-in person's own Souls in this launcher's worlds (GET /__sim/my-souls.json,
// tools/world-launcher/my-souls.mjs), below the worlds and only when there are some. This part is what the homepage
// bundle carries: the read and the section's frame. The cards and their modal are a chunk loaded beside the read
// (HomeSoulCards.tsx), and the 3D body in the modal another (HomeSoulBody.tsx), loaded when a modal opens.
import { lazy, Suspense, useEffect, useState } from 'react';
import { BASE } from '../base-path.ts';
import { useSession, userAuthHeaders } from '../auth-session.ts';
import './home-souls.css';

export type HomeSoul = { id: string; name: string; description: string; bornAt: number; photoUrl: string | null;
  body: { family: 'humanoid'; model: string; params: Record<string, unknown> } | null; worlds: { slug: string; name: string; url: string }[] };
const loadCards = () => import('./HomeSoulCards.tsx');
const Cards = lazy(loadCards);

/** Per viewer: how many cards the last visit showed, so the section holds its place while the list loads (no shift). */
const HELD = 'soul.home-souls';
const readHeld = () => { try { return Math.min(24, Math.max(0, Number(localStorage.getItem(HELD)) || 0)); } catch { return 0; } };
const writeHeld = (n: number) => { try { if (n) localStorage.setItem(HELD, String(n)); else localStorage.removeItem(HELD); } catch { /* private mode: the section appears when it loads */ } };
const Hold = ({ n }: { n: number }) => <div className="lh-cards hs-cards">{Array.from({ length: n }, (_, i) => <span key={i} className="lh-card hs-card hs-hold" aria-hidden="true" />)}</div>;

export function HomeSouls() {
  const session = useSession();
  const [souls, setSouls] = useState<HomeSoul[] | null>(null);
  const [held] = useState(readHeld);
  useEffect(() => {
    if (!session.authed) { setSouls(null); if (session.ready && session.mode !== 'none') writeHeld(0); return; }
    let live = true;
    void loadCards();
    void (async () => {
      try {
        const r = await fetch(`${BASE}/__sim/my-souls.json`, { headers: await userAuthHeaders() });
        const d = r.ok ? await r.json() : null, list = Array.isArray(d?.souls) ? d.souls as HomeSoul[] : [];
        if (live) { setSouls(list); writeHeld(list.length); }
      } catch { if (live) setSouls([]); }
    })();
    return () => { live = false; };
  }, [session.authed, session.ready, session.label]);
  // while the list loads, the cards the last visit showed hold their place (a signed-in person, or a sign-in still settling)
  const holding = souls === null && held > 0 && (session.authed || !session.ready);
  if (!holding && !souls?.length) return null;
  return (
    <div className="hs" role="region" aria-labelledby="hs-h" data-my-souls={souls ? souls.length : 'loading'}>
      <div className="lh-list-head"><h2 className="lh-h" id="hs-h">My Souls {souls && <span className="lh-count">{souls.length}</span>}</h2></div>
      {souls ? <Suspense fallback={<Hold n={souls.length} />}><Cards souls={souls} /></Suspense> : <Hold n={held} />}
    </div>
  );
}

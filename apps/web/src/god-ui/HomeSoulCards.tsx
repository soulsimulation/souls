// #2466: My Souls' cards (photo, else initials, and name) and a Soul's modal: its body idling on the left
// (HomeSoulBody.tsx, loaded on open; the picture shows until it is drawn), and on the right its name, age, description
// and the worlds it lives in. A world opens at the Soul's link with the camera following it. The modal closes on Esc,
// the backdrop or the close button. Loaded beside the read by HomeSouls.tsx.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { soulFragment } from '../soul-link.ts';
import type { HomeSoul } from './HomeSouls.tsx';

const loadBody = () => import('./HomeSoulBody.tsx');
const SoulBody = lazy(loadBody);

/** The world opened at its Soul link, asking the camera to follow the Soul (Shell.tsx reads `follow`). */
export function followLink(worldUrl: string, soulId: string) {
  const u = new URL(worldUrl, location.origin); u.searchParams.set('follow', '1'); u.hash = soulFragment(soulId);
  return u.pathname + u.search + u.hash;
}
const DAY = 86_400_000;
export function bornText(bornAt: number, now = Date.now()) {
  const days = Math.max(0, Math.floor((now - bornAt) / DAY));
  const date = new Date(bornAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `Born ${date} · ${days === 0 ? 'today' : days === 1 ? '1 day old' : `${days} days old`}`;
}

/** The Soul's photo, or its initials on a colour from its id (as SoulAvatar draws them on a world page). */
function SoulPicture({ soul }: { soul: HomeSoul }) {
  const [failed, setFailed] = useState(false);
  if (soul.photoUrl && !failed) return <img className="hs-photo" src={soul.photoUrl} alt="" width={256} height={256} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  let hash = 0; for (const c of soul.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return <span className="hs-photo hs-initials" style={{ background: `hsl(${hash % 360} 38% 46%)` }} aria-hidden="true">{soul.name.split(/\s+/).slice(0, 2).map((n) => n[0]).join('')}</span>;
}

export default function HomeSoulCards({ souls }: { souls: HomeSoul[] }) {
  const [open, setOpen] = useState<HomeSoul | null>(null);
  return <>
    <div className="lh-cards hs-cards">
      {souls.map((s) => (
        <button key={s.id} type="button" className="lh-card hs-card" data-home-soul={s.id} title={s.name} onClick={() => setOpen(s)} onPointerEnter={() => { if (s.body) void loadBody(); }}>
          <SoulPicture soul={s} />
          <span className="lh-label-over"><span className="hs-name">{s.name}</span></span>
        </button>
      ))}
    </div>
    {open && <SoulModal soul={open} onClose={() => setOpen(null)} />}
  </>;
}

function SoulModal({ soul, onClose }: { soul: HomeSoul; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null), closing = useRef(onClose); closing.current = onClose;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null; close.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closing.current(); };
    addEventListener('keydown', esc);
    return () => { removeEventListener('keydown', esc); back?.focus?.(); };
  }, []);
  const [bodyFailed, setBodyFailed] = useState(false);
  return (
    <div className="lh-backdrop hs-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hs-modal" role="dialog" aria-modal="true" aria-labelledby="hs-modal-name" data-soul-modal={soul.id}>
        <button ref={close} type="button" className="hs-close" aria-label="Close" data-soul-modal-close="1" onClick={onClose}>×</button>
        {/* the picture shows until the body is drawn over it (or instead of it: no humanoid look, no WebGL) */}
        <div className="hs-stage">
          <SoulPicture soul={soul} />
          {soul.body && !bodyFailed && <Suspense fallback={null}><SoulBody look={soul.body.params} name={soul.name} onFail={() => setBodyFailed(true)} /></Suspense>}
        </div>
        <div className="hs-details">
          <h2 id="hs-modal-name">{soul.name}</h2>
          <p className="hs-age dim">{bornText(soul.bornAt)}</p>
          {soul.description && <p className="hs-desc">{soul.description}</p>}
          <h3 className="lh-label">{soul.worlds.length === 1 ? 'World' : 'Worlds'}</h3>
          <ul className="hs-worlds">
            {soul.worlds.map((w) => (
              <li key={w.slug}><a href={followLink(w.url, soul.id)} data-follow-world={w.slug}><span>{w.name}</span><span className="hs-go">Follow {soul.name} →</span></a></li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

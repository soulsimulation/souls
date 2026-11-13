// The world list at `<base>/`. Built as its own entry (launcher-entry.tsx), so the home page never downloads the world
// engine; main.tsx renders it too (`vite` dev serves main.tsx for every page). One loading state, styled from the first
// paint by main.css (styles.css: the head's own stylesheet), shows until both the list and its code are in; the list
// then fades in once below the same bar (styles.css).
import { Suspense, lazy, useEffect, useState } from 'react';
import { BASE } from './base-path.ts';
import { EdenMark } from './EdenMark.tsx';
import type { LauncherList } from './god-ui/LauncherHome.tsx';

const loadRoot = () => import('./LauncherRoot.tsx');
const LauncherRoot = lazy(loadRoot);

/** The home page's single loading state: the page's own frame and title, so nothing moves when the list comes in. */
export function LauncherLoading({ failed = false }: { failed?: boolean }) {
  return <main className="world-list lh" data-launcher-loading="1">
    <header className="lh-bar"><div className="lh-title"><EdenMark/><span className="lh-wordmark">Souls</span></div></header>
    {failed
      ? <><p role="status">The world list could not load.</p><button type="button" onClick={() => location.reload()}>Try again</button></>
      : <p role="status" className="lh-loading dim">Loading worlds…</p>}
  </main>;
}

export function WorldList() {
  const [launcher, setLauncher] = useState<LauncherList | null>(null);
  const [checking, setChecking] = useState(true);
  // The public launcher manifest is the sole discovery source; retired cards never appear during loading/failure.
  // The list's code downloads beside it, not after it.
  useEffect(() => { let active = true; void loadRoot().catch(() => {}); void (async () => {
    try { const r = await fetch(BASE + '/__sim/worlds.json', { signal: AbortSignal.timeout(5000) }); const data = r.ok && r.headers.get('content-type')?.includes('application/json') ? await r.json() : null; if (data?.contract === 'local-worlds/1' && typeof data.launcher === 'string' && Array.isArray(data.worlds)) { if (active) setLauncher(data); return; } } catch { /* show the home-page retry state */ }
    if (active) setChecking(false);
  })(); return () => { active = false; }; }, []);
  if (checking && !launcher) return <LauncherLoading />;
  if (!launcher) return <LauncherLoading failed />;
  return <Suspense fallback={<LauncherLoading />}><LauncherRoot list={launcher} /></Suspense>;
}

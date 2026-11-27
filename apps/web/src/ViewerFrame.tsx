import {NavbarMenu} from './NavbarMenu.tsx';
import {FullscreenToggle} from './FullscreenToggle.tsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import {ImportCredits} from './ImportCredits.tsx';
import { createPortal } from 'react-dom';
import type { ViewportInsets, WorldViewerHandle, WorldViewerState } from './WorldViewer.ts';
import { requestBroadcast } from './follow-soul-request.ts';
import { arrivalMark } from './arrival-marks.ts';
import { earlyArrival } from './early-arrival.ts';
import { arrivalFraction, heldLabel, initialPending, reasonDelayMs } from './viewer-arrival.ts';
import { ArrivalLight } from './ArrivalLight.tsx';
import type { InitialWorldProgress } from './InitialWorldReadiness.ts';
import { assetBytes } from './asset-bytes.ts';
import { momentAgo, momentClock, momentDay } from './moment-clock.ts';
import { subscribeWorldZone, worldZone } from './world-zone.ts';
import { arrivalGate } from './gen-mesh/lazy-assets.ts';
import { TouchHints } from './touch/hints.tsx';
import { playSpeed, setPlaySpeed, v2History } from './v2-engine/history.ts';
import { TICK_US } from './v2-engine/takes.ts';
import { momentLink, momentTick } from './v2-engine/moment-link.ts';
// X3: read at module load: Shell rewrites the landing fragment to its tab (#watch) before the scene is ready.
const landingMoment = typeof location === 'undefined' ? null : momentTick(location.hash);

/** Edge overlays are measured against World's actual viewport, never the window. */
export function useViewerInsets(root: RefObject<HTMLDivElement | null>, visible: boolean, layout: string): ViewportInsets {
  const [insets, setInsets] = useState<ViewportInsets>({});
  useLayoutEffect(() => {
    const frame = root.current, viewport = frame?.querySelector('.world-viewport');
    if (!frame || !viewport) return;
    const overlays = [...frame.querySelectorAll<HTMLElement>('.human-panel, .world-hud, .viewer-camera, .viewer-history, .dialogue-dock')];
    const measure = () => {
      const v = viewport.getBoundingClientRect();
      const origin = frame.getBoundingClientRect().top;
      const hud = frame.querySelector<HTMLElement>('.world-hud');
      if (hud) {
        const bottom = `${Math.ceil(hud.getBoundingClientRect().bottom - origin)}px`;
        if (frame.style.getPropertyValue('--app-hud-bottom') !== bottom) frame.style.setProperty('--app-hud-bottom', bottom);
      }
      const camera = frame.querySelector<HTMLElement>('.viewer-camera');
      if (camera) {
        const bottom = `${Math.ceil(camera.getBoundingClientRect().bottom - origin)}px`;
        if (frame.style.getPropertyValue('--app-camera-bottom') !== bottom) frame.style.setProperty('--app-camera-bottom', bottom);
      }
      const next: ViewportInsets = {};
      const phone = matchMedia('(max-width: 700px)').matches;
      if (!frame.classList.contains('has-advanced')) for (const el of overlays) {
        if (el.hidden || (el.matches('.human-panel') && !visible) || el.dataset.inset === 'none' || (el.matches('.viewer-history') && el.closest('.world-hud'))) continue;
        const p = el.getBoundingClientRect();
        if (!p.width || !p.height || p.right <= v.left || p.left >= v.right || p.bottom <= v.top || p.top >= v.bottom) continue;
        // DLG2: the dialogue dock is a left column (desktop) or bottom sheet (phone); keep Souls out from under it.
        const edge = el.matches('.human-panel, .dialogue-dock') ? phone ? 'bottom' : el.matches('.dialogue-dock') ? 'left' : 'right'
          : el.matches('.viewer-history') ? 'bottom'
          : 'top';
        const covered = edge === 'bottom' ? v.bottom - Math.max(v.top, p.top)
          : edge === 'right' ? v.right - Math.max(v.left, p.left)
          : edge === 'left' ? Math.min(v.right, p.right) - v.left
          : Math.min(v.bottom, p.bottom) - v.top;
        next[edge] = Math.max(next[edge] ?? 0, Math.ceil(covered));
      }
      setInsets(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); overlays.forEach(el => observer.observe(el));
    window.addEventListener('resize', measure); measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [root, visible, layout]);
  return insets;
}

/** VF2 (Gene): one "your camera" (drag orbits, right-drag pans, scroll zooms to the pointer, WASD/QE/RF keys;
 * WorldRtsCamera), and a split camera control beside Live: current state / one-click switching, modes and help. */
export function ViewerFrame({ handle, state, dt, navigationOpen, onNavigationChange, worldTime, connected = true, connecting = false, worldName, followName, selectedName, slots, initial }: { handle: WorldViewerHandle | null; state: WorldViewerState | null; dt: number; navigationOpen: boolean; onNavigationChange: (open: boolean) => void; onNavigationOpen?: () => void; worldTime?: string; worldMinutes?: number | null; connected?: boolean; connecting?: boolean; worldName?: string; followName?: string | null; selectedName?: string | null; slots?: { status: HTMLElement | null; camera: HTMLElement | null }; initial?: InitialWorldProgress | null }) {
  const [cameraNote, setCameraNote] = useState('');
  const zone = useSyncExternalStore(subscribeWorldZone, worldZone, worldZone);   // #1649: a real-time world's own time zone
  const [hourOpen, setHourOpen] = useState(false);
  const hourButton = useRef<HTMLButtonElement>(null);
  const hourPanel = useRef<HTMLDivElement>(null);
  // like the music and camera menus: a click anywhere else, or Escape, puts the time panel away
  useEffect(() => {
    if (!hourOpen) return;
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!hourPanel.current?.contains(t) && !hourButton.current?.contains(t)) setHourOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setHourOpen(false); hourButton.current?.focus(); } };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [hourOpen]);
  // X3: a moved world's link to a moment. Opened, the page seeks that moment once and plays from there.
  const [copied, setCopied] = useState<string | null>(null), opened = useRef(false), readAhead = useRef(false);
  // Until it lands, the arrival card stays up and the pill says Loading…: the present is never shown first. It lifts
  // anyway when the world keeps no history, or a while after a seek that found nothing, so a link never holds the page.
  const [landing, setLanding] = useState(landingMoment !== null), [seeked, setSeeked] = useState(false);
  useEffect(() => {
    if (opened.current || !handle || state?.shownTick == null || state.loading) return;
    if (!v2History()) { opened.current = true; setLanding(false); return; }
    // #3358: the moment's bundle is read while the stream catches up, so the seek below only applies it
    if (landingMoment !== null && !readAhead.current) { readAhead.current = true; void v2History()!.prepare(landingMoment).catch(() => {}); }
    // a stream still catching up from its last checkpoint shows an older clock first (Eden on soul.game: hours back), and
    // a seek is never past the shown clock: wait until it reaches the moment, or is about now (a link names a past time)
    if (landingMoment !== null && state.shownTick < landingMoment && state.shownTick * TICK_US < Date.now() * 1000 - 120e6) return;
    opened.current = true;
    if (landingMoment !== null) void handle.seek(landingMoment).finally(() => setSeeked(true));
  }, [handle, state?.shownTick, state?.loading]);
  useEffect(() => {
    if (!landing) return;
    if (seeked && state?.presentation === 'history') { setLanding(false); return; }
    const id = setTimeout(() => setLanding(false), seeked ? 2000 : 60_000);
    return () => clearTimeout(id);
  }, [landing, seeked, state?.presentation]);
  const copyMoment = (tick: number) => {
    const link = momentLink(location.href, tick);
    void navigator.clipboard?.writeText(link).catch(() => {});
    setCopied(link); setTimeout(() => setCopied(null), 4000);
  };
  // K3: a moved world plays from its first moment, at a chosen speed, with a scrub bar over everything since
  const [firstTick, setFirstTick] = useState<number | null>(null), [speed, setSpeed] = useState(playSpeed), [scrub, setScrub] = useState<number | null>(null);
  // a drag shows where it is going and goes there when let go, or after 0.6 s still (keys, and a release the bar never hears)
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubTo = (v: number) => { if (scrubTimer.current) clearTimeout(scrubTimer.current); scrubTimer.current = null; setScrub(null); void handle?.seek(v); };
  const scrubbing = (v: number) => { setScrub(v); if (scrubTimer.current) clearTimeout(scrubTimer.current); scrubTimer.current = setTimeout(() => scrubTo(v), 600); };
  useEffect(() => () => { if (scrubTimer.current) clearTimeout(scrubTimer.current); }, []);
  const fromStart = async () => {
    const h = v2History(), now = state?.shownTick;
    if (!h || now == null) return;
    const us = firstTick !== null ? firstTick * TICK_US : await h.first(now * TICK_US).catch(() => null);
    if (us === null) return;
    setFirstTick(Math.floor(us / TICK_US));
    void handle?.seek(Math.floor(us / TICK_US));
  };
  // the scrub bar's left end (the world's first moment), looked up once the time panel opens or a recording plays
  const shown = state?.shownTick != null;
  useEffect(() => { if ((hourOpen || state?.presentation === 'history') && firstTick === null && state?.shownTick != null) void v2History()?.first(state.shownTick * TICK_US).then((us) => { if (us !== null) setFirstTick(Math.floor(us / TICK_US)); }).catch(() => {}); }, [hourOpen, state?.presentation, firstTick, shown]);
  // #3358: the panel open, what Back 1 min and From the start would read is read ahead (history.ts prepare)
  useEffect(() => {
    const h = v2History(), now = state?.shownTick;
    if (!hourOpen || !h || now == null) return;
    void h.prepare(now - 60e6 / TICK_US, now).catch(() => {});
    void h.first(now * TICK_US).then((us) => (us === null ? undefined : h.prepare(Math.floor(us / TICK_US), now))).catch(() => {});
  }, [hourOpen]);
  const help = useRef<HTMLDivElement>(null);
  const unavailable = !!state?.unavailableReason;
  const current = state?.shownTick != null && !state.loading && !unavailable;
  // VF1: arriving = no frame drawn yet. It gets one calm card (not warnings); a drawn view that stops being
  // current says why only once that lasts (transient gaps never flash), and the pill never says "Held".
  const reason = state?.unavailableReason ?? null;
  const blocked = !!reason && /graphics|3D|stream is not available/.test(reason);
  const drawnOnce = useRef(false);
  if (state?.shownTick != null && !state.loading) drawnOnce.current = true;
  const arriving = !blocked && (landing || !state || state.shownTick == null || (state.loading && !drawnOnce.current));
  const [settledReason, setSettledReason] = useState<string | null>(null);
  useEffect(() => {
    if (!reason || arriving) { setSettledReason(null); return; }
    const id = setTimeout(() => setSettledReason(reason), reasonDelayMs(reason, settledReason, blocked));
    return () => clearTimeout(id);
  }, [reason, arriving, blocked]); // eslint-disable-line react-hooks/exhaustive-deps -- the line shown when the reason changed
  // The card also carries the initial-assets progress (the world stays hidden until those assets are ready), so it
  // stays until they are, and steps aside when they fail: the viewer's own Retry is then the only thing to show.
  // Without such a gate (world-engine worlds) the bar follows the actual asset downloads while the card shows.
  const preparing = initialPending(initial);
  // lane PERF: a new world's card also waits for the GLBs nearest the arrival (gen-mesh/lazy-assets.ts, ≤ 30 s), so the
  // first view is the world, not bare ground filling in; old worlds never plan an eager set, so this is false there
  const assetsNear = useSyncExternalStore(arrivalGate.subscribe, arrivalGate.pending, arrivalGate.pending);
  // P7 lever D: a phone's new world drawn before the live data came: only the nearest assets still hold the card
  const early = useSyncExternalStore(earlyArrival.subscribe, earlyArrival.shown, earlyArrival.shown);
  if (early) drawnOnce.current = true;
  const card = ((!early && (arriving || preparing)) || assetsNear) && initial?.stage !== 'failed';
  // P7d: a world already drawn before this page part came shows no light (index.html's boot light finishes that arrival).
  // #1166: the light plays once; it never returns over a world it has dissolved into.
  const [arrivalShown, setArrivalShown] = useState(() => !earlyArrival.shown());
  const lightGone = useRef(earlyArrival.shown());
  const [shot] = useState(() => /[?&]shot=/.test(location.search));
  useEffect(() => { if (card) { if (!lightGone.current) setArrivalShown(true); return; } arrivalMark('card-done'); }, [card]);
  const arrivalGone = useCallback(() => { lightGone.current = true; setArrivalShown(false); }, []);
  // The bar counts bytes (asset-bytes.ts: every asset fetch, total known up front), never files; it only moves forward
  // and is full once the world is ready. Without a byte total yet, the older measures stand in.
  const bytes = useSyncExternalStore(assetBytes.subscribe.bind(assetBytes), () => assetBytes.snapshot(), () => assetBytes.snapshot());
  // new worlds learn their total from the snapshot a moment after the first downloads start: no bar until then
  // #1266: one progress for the bar and the light: bytes, then preparation, and 100% only once the world is drawn
  const measured = !card ? (arrivalShown ? 1 : null) : arrivalFraction({ card, bytes, initial, downloads: state?.assetDownloads, arriving });
  const peak = useRef(0);  // a file fetched again after an abort restarts its count: the bar (and its MB) hold, never step back
  if (!card) peak.current = 0;
  const progress = measured === null ? null : card ? (peak.current = Math.max(peak.current, Math.min(1, measured))) : measured;
  const lost = !connected && !arriving;
  const live = current && state?.presentation === 'live' && connected;
  const status = blocked && state?.shownTick == null ? 'View unavailable'
    : arriving || state!.loading ? 'Loading…'
    : lost ? 'Reconnecting…'
    : settledReason ? heldLabel(settledReason)
    : state!.presentation === 'history' ? 'Recorded' : 'Live';
  // #892: a glide to a Soul (flyToSoul) is Follow on its way, not your camera (no "Free" flash between two Souls)
  const kind = state?.cameraMode === 'follow' || state?.flyingTo ? 'follow' : state?.cameraMode === 'manual' ? 'yours' : 'broadcast';
  // Touch gestures on phones/tablets, read when the help is shown (the window may have been resized since).
  const touch = navigationOpen && (() => { try { return matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 700px)').matches; } catch { return false; } })();
  const close = () => { onNavigationChange(false); setCameraNote(''); document.querySelector<HTMLElement>('.camera-menu .navbar-menu-trigger')?.focus(); };
  // VF6 (Gene: "if you touch WASD you break out of that mode so it's intuitive"): a short cue when Follow starts,
  // and a shorter one when a move key (or ×) hands the camera back to you.
  const [followCue, setFollowCue] = useState<'' | 'follow' | 'free' | 'held'>('');
  // #1316: a pull out (zoom out, drag round) keeps the viewer's view; a cue says so once, and how to hand it back.
  const held = kind === 'follow' && !!state?.followHeld;
  const lastKind = useRef(kind), lastHeld = useRef(held);
  useEffect(() => {
    const was = lastKind.current, wasHeld = lastHeld.current; lastKind.current = kind; lastHeld.current = held;
    if (kind === was && held === wasHeld) return;
    const cue = held && !wasHeld ? 'held' : kind === was ? '' : kind === 'follow' ? 'follow' : was === 'follow' && kind === 'yours' ? 'free' : '';
    setFollowCue(cue); if (!cue) return;
    const id = setTimeout(() => setFollowCue(''), cue === 'free' ? 2500 : 5000); return () => clearTimeout(id);
  }, [kind, held]);
  const coarse = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  useEffect(() => {
    if (!navigationOpen) return;
    handle?.releaseInput?.(); help.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [navigationOpen, handle, onNavigationChange]);
  const toBroadcast = () => { setCameraNote(''); requestBroadcast(); handle?.setCameraMode('broadcast'); };
  const yourCamera = () => { setCameraNote(''); if (handle?.setManualNavigation) handle.setManualNavigation('orbit'); else handle?.setCameraMode('manual'); };
  // VF3 (Gene): the status and the camera chip live in the top bar (Shell's slots); nothing sits at the bottom of the screen.
  // Gene (24 Nov): the top bar holds ONE time control, the pill ("● Live", or "● Recorded · <clock of the moment shown>").
  // Everything else about time is in the panel it opens: the one clock, Back 1 min, Pause/Play, speed, the scrub bar,
  // From the start, Link to this moment and Return to live. The old time-of-day preview (a second, view-only clock) is gone.
  const v2 = !!v2History();
  const shownTick = state?.shownTick ?? null;
  const recorded = state?.presentation === 'history';
  // a moved world's tick is world time in µs since the epoch: its clock is the real time of the moment shown
  const shownMs = v2 && shownTick != null ? shownTick * TICK_US / 1000 : null;
  const clock = shownMs !== null ? momentClock(shownMs, zone) : worldTime?.split(' · ').slice(-1)[0] ?? '';
  const day = shownMs !== null ? momentDay(shownMs, zone) : worldTime?.includes(' · ') ? worldTime.split(' · ')[0] : '';
  const ago = recorded && shownMs !== null ? momentAgo(shownMs, Date.now()) : '';
  const busy = !handle || shownTick == null || !!state?.loading;
  const minute = v2 ? 60e6 / TICK_US : 60 / dt;
  const back = () => { if (shownTick != null) void handle?.seek(Math.max(0, shownTick - minute)); };
  // Pause from live holds the moment shown: a seek to it (the recording plays from there), then paused
  const pause = async () => { if (shownTick == null || !handle) return; if (!recorded) await handle.seek(shownTick); handle.setPlaying(false); };
  const playing = recorded && state?.playback === 'playing';
  const pillText = arriving || state?.loading || lost || settledReason ? status : recorded ? clock ? `Recorded · ${clock}` : 'Recorded' : 'Live';
  const pillClass = arriving || state?.loading ? 'loading' : lost || settledReason || !current || !connected ? 'warn' : recorded ? 'recorded' : 'ok';
  const panelPlace = (): CSSProperties => {
    const r = hourButton.current?.getBoundingClientRect(), top = r?.height ? r.bottom + 8 : 60;  // a phone's pill is hidden behind the menu
    return innerWidth <= 700 ? { top, left: 16, right: 16, width: 'auto' } : { top, left: Math.max(16, Math.min((r?.left ?? 16) - 4, innerWidth - 336)) };
  };
  const statusBlock = <div className="viewer-history" data-viewer-navigation={state?.manualNavigation ?? ''} data-viewer-input={state?.inputOwned ?? false} data-viewer-mode={state?.cameraMode ?? ''} data-viewer-presentation={state?.presentation ?? ''} data-viewer-tick={state?.shownTick ?? ''} data-viewer-selection={state?.selection.soulId ?? state?.selection.entityId ?? ''} data-viewer-ready={!!handle}>
      <div className="row viewer-status">
        <button ref={hourButton} type="button" className="time-pill" disabled={arriving} aria-expanded={hourOpen} aria-haspopup="dialog" aria-label={`${pillText}: time controls`} title="Time: go back, pause, play, share this moment" onClick={() => setHourOpen(!hourOpen)}>
          <span className={pillClass} data-viewer-status data-viewer-live={live}>{pillText}</span>
        </button>
        {hourOpen && !arriving && createPortal(<div ref={hourPanel} className="time-panel" role="dialog" aria-label="Time" data-time-panel={recorded ? 'recorded' : 'live'} style={panelPlace()}>
          <div className="time-panel-head">
            <span className="time-panel-clock" data-moment-clock={shownTick ?? ''}>{clock || '—'}</span>
            <span className={recorded ? 'time-panel-tag recorded' : 'time-panel-tag'}>{recorded ? 'Recorded' : 'Live'}</span>
          </div>
          <span className="time-panel-day">{[day, ago, zone ? `time in ${zone.replace(/_/g, ' ')}` : ''].filter(Boolean).join(' · ')}{state?.loading ? ' · loading that moment…' : ''}</span>
          <div className="time-panel-row" role="group" aria-label="Playback">
            <button type="button" disabled={busy} onClick={back}>Back 1 min</button>
            {playing ? <button type="button" disabled={busy} onClick={() => handle?.setPlaying(false)}>Pause</button>
              : recorded ? <button type="button" disabled={busy} onClick={() => handle?.setPlaying(true)}>Play</button>
              : <button type="button" disabled={busy} onClick={() => void pause()}>Pause</button>}
            {v2 && recorded && <button type="button" title="Playback speed" aria-label={`Speed ×${speed}: play faster`} onClick={() => { const x = speed >= 8 ? 1 : speed * 2; setPlaySpeed(x); setSpeed(x); }}>×{speed}</button>}
          </div>
          {v2 && firstTick !== null && shownTick != null && <input type="range" aria-label="Every moment since the world began" min={firstTick} max={Math.max(firstTick + 1, Math.floor(Date.now() * 1000 / TICK_US))} step={1} value={scrub ?? shownTick} onChange={(e) => scrubbing(Number(e.target.value))} onPointerUp={(e) => scrubTo(Number((e.target as HTMLInputElement).value))} />}
          <div className="time-panel-row" role="group" aria-label="Moments">
            {v2 && <button type="button" disabled={busy} title="Play this world from the first moment it ran" onClick={() => void fromStart()}>From the start</button>}
            {v2 && <button type="button" disabled={shownTick == null} data-moment-link={copied ?? ''} title="Copy a link that opens the world at this moment" onClick={() => copyMoment(shownTick!)}>{copied ? 'Copied' : 'Link to this moment'}</button>}
            {recorded && <button type="button" className="time-panel-live" onClick={() => handle?.live()}>Return to live</button>}
          </div>
        </div>, document.body)}
        {!arriving&&!!state?.assetDownloads?.pending&&<span className="asset-download-note" role="status" title="Actual asset downloads; the world stays usable while art arrives.">Art loading · {state.assetDownloads.loaded}/{state.assetDownloads.total}</span>}
        {settledReason && !lost && <span role="status" className="warn viewer-reason" title={settledReason}>{settledReason}</span>}
      </div>
    </div>;
  // #893: phones get the camera menu as a bottom sheet; Follow appears when a Soul is selected.
  const phoneSheet = coarse || (() => { try { return matchMedia('(max-width: 700px)').matches; } catch { return false; } })();
  const followable = state?.selection.soulId ?? null;
  const cameraLabel=arriving?'Loading':kind==='follow'?`Following ${followName??(!state?.selection.soulId&&state?.selection.entityId?'a thing':'a Soul')}`:kind==='yours'?'Free':'Broadcast';
  const cameraAction=kind==='broadcast'?'Switch to Free camera':'Return to Broadcast';
  const cameraBlock=<div className="viewer-camera-chip camera-split" data-camera={kind} data-follow-soul={kind==='follow'?state?.selection.soulId??'':undefined}>
    <button type="button" className="camera-main" disabled={!handle||arriving} aria-label={`${cameraLabel}: ${cameraAction}`} title={cameraAction} data-tooltip={cameraAction} onClick={()=>kind==='broadcast'?yourCamera():toBroadcast()}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5h3l1.4-2h5.2l1.4 2h3v9.5H3z" fill="none" stroke="currentColor" strokeWidth="1.5"/><circle cx="10" cy="11" r="3" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg><span className={kind==='follow'?'viewer-following-label':undefined}>{cameraLabel}</span>
    </button>
    <NavbarMenu label="Camera modes and help" className="camera-menu" sheet={phoneSheet} trigger={<span aria-hidden="true">⌄</span>}>
      {dismiss=><><button type="button" aria-pressed={kind==='broadcast'} disabled={!handle||arriving} onClick={()=>{toBroadcast();dismiss();}}>Broadcast</button>
      <button type="button" aria-pressed={kind==='yours'} disabled={!handle||arriving} onClick={()=>{yourCamera();dismiss();}}>Free</button>
      {phoneSheet&&kind!=='follow'&&followable&&state?.flyingTo!==followable&&<button type="button" disabled={!handle||arriving||state?.presentation==='history'} onClick={()=>{handle?.flyToSoul?.(followable,{chip:coarse});dismiss();}}>Follow {selectedName ?? 'this Soul'}</button>}
      {held&&followable&&<button type="button" disabled={!handle||arriving||state?.presentation==='history'} onClick={()=>{handle?.flyToSoul?.(followable,{chip:coarse});dismiss();}}>Follow {followName ?? 'this Soul'} again</button>}
      {kind==='follow'&&<button type="button" onClick={()=>{yourCamera();dismiss();}}>Stop following</button>}
      <button type="button" onClick={()=>{dismiss();onNavigationChange(true);}}>Camera controls</button><FullscreenToggle/></>}
    </NavbarMenu>
  </div>;
  return <>
    {!arriving && <TouchHints />}
    {arrivalShown && !blocked && initial?.stage !== 'failed' && <ArrivalLight title={worldName ?? ''} progress={progress} done={!card} card={card} instant={shot} onGone={arrivalGone} />}
    {followCue && !arriving && <div className="viewer-follow-hint" role="status" aria-live="polite" data-cue={followCue}>{followCue === 'held'
      ? <>Your view of <b>{followName ?? 'the Soul'}</b> stays put · <b>Follow</b> again to let the camera frame them</>
      : followCue === 'follow'
      ? coarse ? <>Following <b>{followName ?? 'a Soul'}</b> · swipe for the next Soul · tap the ground to take over</> : <>Following <b>{followName ?? 'a Soul'}</b> · drag to look around, scroll to zoom · press <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to look around freely</>
      : <>Your camera · <b>Return to Broadcast</b> is top left</>}</div>}
    {navigationOpen && <div className="camera-help-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="camera-help" role="dialog" aria-modal="true" aria-labelledby="camera-help-title" tabIndex={-1} ref={help}>
        <button type="button" className="camera-help-close" aria-label="Close" title="Close (Esc)" onClick={close}><span aria-hidden="true">×</span></button>
        <h2 id="camera-help-title">Camera</h2>
        <p><b>Broadcast</b> directs itself, cutting between Souls and whatever is happening. Any drag, scroll or move key gives you the camera; <b>the camera button</b> (top left, beside Live) returns it.</p>
        {touch ? <><h3>Touch</h3>
          <ul className="camera-keys"><li><span>Thumb, lower left</span><span>walk (hold still first to keep walking)</span></li><li><span>One finger</span><span>look around in place</span></li><li><span>Pinch</span><span>glide toward or away</span></li><li><span>Two fingers up · down</span><span>rise · lower</span></li><li><span>Double-tap</span><span>fly there</span></li><li><span>Tap a Soul or its name plate</span><span>follow it</span></li><li><span>Swipe sideways while following</span><span>the next Soul</span></li><li><span>Tap the ground while following</span><span>your camera, there</span></li></ul></> : <><h3>Mouse</h3>
          <ul className="camera-keys"><li><span>Drag</span><span>orbit around the centre</span></li><li><span>Right-drag</span><span>look around in place</span></li><li><span>Scroll</span><span>zoom toward the pointer</span></li><li><span>Double-click</span><span>fly there</span></li><li><span>Click a name plate</span><span>meet that Soul</span></li></ul>
          <h3>Keyboard</h3>
          <ul className="camera-keys"><li><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>forward · back · sideways, staying level</span></li><li><span>← → · ↑ ↓</span><span>turn · look up and down</span></li><li><span><kbd>Q</kbd><kbd>E</kbd></span><span>lower · raise</span></li><li><span><kbd>R</kbd><kbd>F</kbd></span><span>raise · lower, too</span></li><li><span><kbd>Shift</kbd></span><span>faster</span></li><li><span><kbd>Alt</kbd></span><span>slow precision movement</span></li></ul></>}
        <p className="camera-help-follow"><b>Follow</b> a Soul from its card{touch ? ' (or tap it)' : ''}: the camera stays on it. Drag orbits around it, scroll zooms{touch ? ', pinch zooms' : ''}. {touch ? 'Tap the ground or choose Free to stop following' : 'Right-drag, a navigation key, or Free stops following'}, right where you are.</p>
        <div className="camera-help-actions">
          <button type="button" disabled={kind === 'broadcast' || !handle} onClick={() => { toBroadcast(); close(); }}>Back to broadcast</button>
          <button type="button" disabled={kind === 'broadcast' || !current || !handle?.resetView} onClick={() => setCameraNote(handle?.resetView?.() ? '' : 'The current view could not be reset.')}>Reset view</button>
        </div>
        {cameraNote && <p role="status">{cameraNote}</p>}
        <ImportCredits />
      </div>
    </div>}
    {slots ? <>{slots.status && createPortal(statusBlock, slots.status)}{slots.camera && createPortal(cameraBlock, slots.camera)}</>
      : <div className="viewer-bottom">{statusBlock}{cameraBlock}</div>}
  </>;
}

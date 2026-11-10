import {useRef,useSyncExternalStore} from 'react';
import {NavbarMenu} from './NavbarMenu.tsx';
import {audioSettings,serverAudioSettings,setAudioSettings,subscribeAudioSettings} from './audio-settings.ts';
import {MUSIC_STATIONS} from './music-stations.ts';
import {musicRetry,musicSkip,musicView,pieceTitle,subscribeMusicView} from './music-status.ts';
const MUSIC_LABEL={off:'Off',starting:'Starting…',playing:'On',blocked:'Tap to play'} as const;
export function AudioMenu(){
 const settings=useSyncExternalStore(subscribeAudioSettings,audioSettings,serverAudioSettings);
 const music=useSyncExternalStore(subscribeMusicView,musicView,musicView);
 // #1389: the row says what is sounding, not only the setting; held back by the browser, a tap on it tries again
 const status=settings.music?(music.status==='off'?'starting':music.status):'off',blocked=status==='blocked';
 // the page's own tap handler retries before this click lands, so the click remembers what the row said when pressed
 const pressedBlocked=useRef(false),press=()=>{pressedBlocked.current=blocked;};
 return <NavbarMenu label="Audio" className={'navbar-audio'+(blocked?' music-blocked':'')} trigger={<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" fill="none" stroke="currentColor" strokeWidth="1.6"/></svg>}>
  <button type="button" role="switch" aria-checked={!settings.muted} onClick={()=>setAudioSettings({muted:!settings.muted})}>Sound effects <b>{settings.muted?'Off':'On'}</b></button>
  <button type="button" role="switch" aria-checked={settings.music} data-music={status} onPointerDown={press} onKeyDown={press} onClick={()=>{const retry=blocked||pressedBlocked.current;pressedBlocked.current=false;if(retry)musicRetry();else setAudioSettings({music:!settings.music});}}>Music <b>{MUSIC_LABEL[status]}</b></button>
  <div className="audio-track" role="group" aria-label="Track">
   <button type="button" aria-label="Previous track" title="Previous track" onClick={()=>musicSkip(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5 9 12l10 7z" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg></button>
   <span aria-live="polite">{music.piece?pieceTitle(music.piece):'Random track'}</span>
   <button type="button" aria-label="Next track" title="Next track" onClick={()=>musicSkip(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l10 7-10 7z" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg></button>
  </div>
  <label>Radio station<select aria-label="Radio station" value={settings.station} onChange={e=>setAudioSettings({station:e.target.value})}>{MUSIC_STATIONS.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
 </NavbarMenu>;
}

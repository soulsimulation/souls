// The radio's controls on Engine v2's page (V22, #3337), beside V21's sound switch, as today's audio menu
// (apps/web/src/AudioMenu.tsx) has them: music on or off ("tap to play" when the browser held it back), the previous and
// next track, and the station. The station and the music switch are kept under today's keys, so a visitor's choices
// carry over between the two pages; the track last chosen with previous or next is kept too and starts the next visit.
import { MUSIC_STATIONS, musicStation } from './music-stations.ts';
import { musicRetry, musicSkip, musicView, pieceTitle, subscribeMusicView, type MusicStatus } from './music-status.ts';

type Store = Pick<Storage, 'getItem' | 'setItem'> | null;
export const STATION_KEY = 'sim.music.station', INDEPENDENT_KEY = 'sim.audio.independent', PIECE_KEY = 'sim.music.piece';
const get = (s: Store, k: string) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const put = (s: Store, k: string, v: string) => { try { s?.setItem(k, v); } catch { /* a private window */ } };

export const loadStation = (s: Store) => musicStation(get(s, STATION_KEY));
export const saveStation = (s: Store, id: string) => put(s, STATION_KEY, musicStation(id));
export const loadPiece = (s: Store) => get(s, PIECE_KEY);
/** Today's rule (apps/web/src/audio-settings.ts): settings saved before effects and music were separate switches (no
 *  `sim.audio.independent`) read a mute as music off too. */
export const musicWanted = (s: Store, music: boolean, muted: boolean) => (muted && get(s, INDEPENDENT_KEY) !== '1' ? false : music);
/** Any change of a switch marks them independent, as today's menu does. */
export const markIndependent = (s: Store) => put(s, INDEPENDENT_KEY, '1');

const LABEL: Record<MusicStatus, string> = { off: 'off', starting: 'starting…', playing: 'on', blocked: 'tap to play' };
const STYLE = { font: '12px system-ui', padding: '4px 8px', opacity: '0.85' };

/** Puts the controls in `bar`. `music()` reads the switch and `setMusic()` changes and saves it; `station()` and
 *  `setStation()` the same for the station. */
export function musicControls(bar: HTMLElement, o: { store: Store; music(): boolean; setMusic(on: boolean): void; station(): string; setStation(id: string): void }) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, label: string) => {
    const e = document.createElement(tag);
    Object.assign(e.style, STYLE);
    e.setAttribute('aria-label', label);
    e.title = label;
    bar.append(e);
    return e;
  };
  const button = el('button', 'Music');
  const prev = el('button', 'Previous track');
  const title = el('span', 'Track');
  const next = el('button', 'Next track');
  const select = el('select', 'Radio station');
  prev.textContent = '⏮';
  next.textContent = '⏭';
  Object.assign(title.style, { background: 'rgba(255,255,255,0.85)', color: '#222', borderRadius: '3px' });
  title.setAttribute('aria-live', 'polite');
  for (const s of MUSIC_STATIONS) select.append(new Option(s.label, s.id));
  select.value = o.station();
  // The page's own gesture handler retries a blocked start before this click lands: the click goes by what the
  // button said when it was pressed, as today's menu does.
  let pressedBlocked = false, skipped = false;
  const status = (): MusicStatus => (o.music() ? (musicView().status === 'off' ? 'starting' : musicView().status) : 'off');
  button.addEventListener('pointerdown', () => (pressedBlocked = status() === 'blocked'));
  button.onclick = (e) => {
    e.stopPropagation();
    const retry = status() === 'blocked' || pressedBlocked;
    pressedBlocked = false;
    if (retry) musicRetry();
    else o.setMusic(!o.music());
    show();
  };
  const skip = (step: number) => (e: MouseEvent) => { e.stopPropagation(); skipped = true; musicSkip(step); show(); };
  prev.onclick = skip(-1);
  next.onclick = skip(1);
  select.onchange = () => o.setStation(select.value);
  const show = () => {
    const s = status(), piece = musicView().piece;
    button.textContent = `music ${LABEL[s]}`;
    button.dataset.music = s;
    button.setAttribute('aria-pressed', String(o.music()));
    title.textContent = piece ? pieceTitle(piece) : 'Random track';
    if (skipped && piece) (skipped = false), put(o.store, PIECE_KEY, piece);
  };
  subscribeMusicView(show);
  show();
}

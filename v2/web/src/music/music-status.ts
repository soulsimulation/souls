/** #1389/#1393: what the music player is actually doing, for the audio menu, and the menu's track controls. The player
 *  (gen-mesh/music.ts, in the sound layer's chunk) writes the status and registers its controls; the menu only reads. */
export type MusicStatus = 'off' | 'starting' | 'playing' | 'blocked';
export type MusicView = { status: MusicStatus; piece: string | null };
type Controls = { skip(step: number): void; retry(): void };

let view: MusicView = { status: 'off', piece: null }, controls: Controls | null = null;
const listeners = new Set<() => void>();
export const musicView = () => view;
export function subscribeMusicView(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function setMusicView(next: MusicView) {
  if (next.status === view.status && next.piece === view.piece) return;
  view = next; for (const fn of listeners) fn();
}
export function registerMusicControls(c: Controls | null) { controls = c; }
/** Previous (-1) or next (+1) track: plays it when music is on, only selects it when off. */
export const musicSkip = (step: number) => controls?.skip(step);
/** Try a blocked start again, from inside the tap that asks for it. */
export const musicRetry = () => controls?.retry();
/** 'skylight-rain' → 'Skylight rain'. */
export const pieceTitle = (id: string | null) => id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ') : '';

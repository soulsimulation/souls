/** VF1: what a visitor is told about the connection and the first frame.
 *
 * "Reconnecting" is only true after a socket that was open has been down for a moment: the very first connect
 * is part of arriving, and a quick drop-and-reconnect (the browser was busy, the network blinked) is invisible
 * because playback runs a moment behind the server on frames it already holds. */
import type { InitialWorldProgress } from './InitialWorldReadiness.ts';

export const RECONNECT_GRACE_MS = 3000;

type ConnLike = { stats: { state: string; reconnects?: number } };
const seen = new WeakMap<object, { everOpen: boolean; downSince: number | null }>();

/** True only when a previously open connection has been down for at least RECONNECT_GRACE_MS. */
export function connectionLost(conn: ConnLike | null | undefined, now = performance.now()): boolean {
  if (!conn) return false;
  let s = seen.get(conn);
  if (!s) { s = { everOpen: false, downSince: null }; seen.set(conn, s); }
  if (conn.stats.state === 'open') { s.everOpen = true; s.downSince = null; return false; }
  if (!s.everOpen && !(conn.stats.reconnects ?? 0)) return false; // still arriving
  s.downSince ??= now;
  return now - s.downSince >= RECONNECT_GRACE_MS;
}

/** The arrival card's line for a viewer that has not drawn its first frame yet. */
export function arrivalStage(reason: string | null | undefined, connecting: boolean): string {
  if (connecting) return 'Connecting to the world';
  if (!reason || /recorded world frame/i.test(reason)) return 'Catching the first moments';
  if (/scenery/i.test(reason)) return 'Loading the scenery';
  return 'Getting the view ready';
}

/** A short, plain pill label for a drawn view that is not live right now. */
export function heldLabel(reason: string | null | undefined): string {
  if (!reason) return 'Live';
  if (/reconnect/i.test(reason)) return 'Reconnecting…';
  if (/graphics|3D/i.test(reason)) return 'View paused';
  if (/covered by controls/i.test(reason)) return 'View hidden';
  return 'Catching up';
}

/** True while the viewer's initial-assets gate still hides the world (a failure shows its own Retry instead). */
export function initialPending(initial: InitialWorldProgress | null | undefined): boolean {
  return !!initial && initial.stage !== 'ready' && initial.stage !== 'failed';
}

/** The arrival card's bar, 0..1, for the initial-assets gate; null while nothing is measurable yet.
 * Bytes when the whole download graph is known, else world parts prepared; full once everything has arrived. */
export function arrivalProgress(initial: InitialWorldProgress | null | undefined): number | null {
  if (!initial) return null;
  if (initial.stage === 'preparing' || initial.stage === 'first-frame') return 1;
  if (initial.stage !== 'downloading') return null;
  if (initial.bytesTotal !== null && initial.bytesTotal > 0) return Math.min(1, Math.max(0, initial.bytesLoaded / initial.bytesTotal));
  if (initial.required > 0) return Math.min(1, Math.max(0, initial.completed / initial.required));
  return null;
}

/** Without an initial gate, the bar follows the actual asset downloads (finished of started) while any are pending. */
export function assetDownloadProgress(d: { loaded: number; failed: number; total: number; pending: number } | null | undefined): number | null {
  return d && d.pending > 0 && d.total > 0 ? Math.min(1, Math.max(0, (d.loaded + d.failed) / d.total)) : null;
}

/** #1266: the arrival's one progress, 0..1, shown by the bar and by the white light's radius alike. Its first steps are
 *  the page's code running (STARTED) and the world's data arriving (WORLD_DATA); the download in bytes then takes it to
 *  BYTES_SHARE; the world's preparation and its first frame take it to FIRST_FRAME; 1 only once the world is drawn (the
 *  card has gone). Never 1 while the world is still being prepared. */
export const STARTED = 0.02, WORLD_DATA = 0.06, BYTES_SHARE = 0.85, PREPARING = 0.9, FIRST_FRAME = 0.95;
/** The download's part of the arrival, for a fraction of its bytes (the first paint's boot light uses it too). */
export const downloadShare = (d: number) => WORLD_DATA + (BYTES_SHARE - WORLD_DATA) * Math.min(1, Math.max(0, d));
export function arrivalFraction(o: {
  card: boolean; bytes: { loaded: number; total: number; known: boolean }; initial: InitialWorldProgress | null | undefined;
  downloads?: { loaded: number; failed: number; total: number; pending: number } | null; arriving: boolean;
}): number {
  if (!o.card) return 1;
  const stage = o.initial?.stage;
  const download = o.bytes.known && o.bytes.total > 0 ? o.bytes.loaded / o.bytes.total
    : stage === 'downloading' ? arrivalProgress(o.initial) : !o.initial && o.arriving ? assetDownloadProgress(o.downloads) : null;
  // before any bytes are measurable: the page's code is running; then the world's data has come (its gate exists)
  let f = download === null ? (o.initial || !o.arriving ? WORLD_DATA : STARTED) : downloadShare(download);
  // then two steps the page can see: the world is being built from what arrived, and its first frame is being drawn
  if (stage === 'preparing') f = Math.max(f, PREPARING);
  if (stage === 'first-frame') f = Math.max(f, FIRST_FRAME);
  return Math.min(FIRST_FRAME, f);
}

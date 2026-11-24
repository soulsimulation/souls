/** A planned camera (#1963; 0.135 P3 on the new engine). `?track=<url>` loads a `souls-shot/1` file: camera data, and
 *  either the recorded range it belongs to (`fromTick`, `toTick`, `dt`: take ticks, as `#t=` moments name them) or
 *  `live: true` with its length in `seconds`, for a take recorded as it happens (a staged scene). A range: while the
 *  viewer shows a tick inside it the camera is the track's pose at that tick. Live: from the capture's `play()` the
 *  camera is the pose at the seconds since, holding the last pose after the end. Outside either nothing changes.
 *  The camera only reads: the people come from the stream or the recording the viewer already plays. Loaded only when
 *  asked for. */
import { sampleTrack, type CameraTrackData } from '../../../mars/viewer/engine/camera/track.ts';
import type { CameraPose } from '../../../mars/viewer/engine/camera/shots.ts';

export type ShotTrack = { schema: 'souls-shot/1'; fromTick?: number; toTick?: number; dt?: number; live?: boolean; seconds?: number; aspect: number; move: string; track: CameraTrackData };
export type ShotPlayback = { seek(tick: number): Promise<void>; setPlaying(playing: boolean): boolean; tick(): number | null };

export function parseShotTrack(x: unknown): ShotTrack | null {
  const s = x as Partial<ShotTrack> | null, t = s?.track;
  if (!s || s.schema !== 'souls-shot/1') return null;
  if (s.live === true ? !(s.seconds! > 0) : !Number.isFinite(s.fromTick) || !Number.isFinite(s.toTick) || !(s.toTick! > s.fromTick!) || !(s.dt! > 0)) return null;
  if (!t || t.schema !== 'mars-camera-track/1' || !(t.hz > 0) || !Array.isArray(t.samples) || !t.samples.length) return null;
  if (!t.samples.every(p => [...p.position, ...p.target, p.fov].every(Number.isFinite))) return null;
  return s as ShotTrack;
}
/** The track's pose at a shown tick, or null outside its range. The last pose holds for HOLD_SECONDS after the range, so a
 *  take that stops a frame late does not end on another camera. */
export const HOLD_SECONDS = 1;
export function shotPose(shot: ShotTrack, tick: number): CameraPose | null {
  if (shot.live) return null;
  return tick >= shot.fromTick! && tick <= shot.toTick! + HOLD_SECONDS / shot.dt! ? sampleTrack(shot.track, (tick - shot.fromTick!) * shot.dt!) : null;
}
/** A live track's pose `elapsed` seconds after its play(), or null before it; the last pose holds after its end. */
export function livePose(shot: ShotTrack, elapsed: number | null): CameraPose | null {
  return shot.live && elapsed !== null && elapsed >= 0 ? sampleTrack(shot.track, Math.min(elapsed, shot.seconds!)) : null;
}
/** The pose for this frame: a range's at the shown tick (`tick`, null when the viewer is live), a live track's by the
 *  clock (`nowMs`, the page's performance.now()) since its play(). */
let playedAt: number | null = null;
export function poseNow(shot: ShotTrack, tick: number | null, nowMs: number): CameraPose | null {
  return shot.live ? livePose(shot, playedAt === null ? null : (nowMs - playedAt) / 1000) : tick === null ? null : shotPose(shot, tick);
}
/** Same-origin paths only: a track is a file beside the page, never another site's. */
export const shotTrackUrl = (search: string) => { const v = new URLSearchParams(search).get('track'); return v && /^\/[^/\\]/.test(v) ? v : null; };

export async function loadShotTrack(url: string, signal: AbortSignal, playback: ShotPlayback): Promise<ShotTrack | null> {
  const r = await fetch(url, { signal }); if (!r.ok) return null;
  const shot = parseShotTrack(await r.json()); if (!shot) return null;
  playedAt = null;
  // The capture tool's handle: a range is cued paused on its first frame, then played at the world's own speed; a live
  // track is cued as it is and starts its clock at play().
  (globalThis as { __soulsShot?: unknown }).__soulsShot = shot.live
    ? { live: true, seconds: shot.seconds, move: shot.move, tick: playback.tick, cue: async () => true, play: () => { playedAt = performance.now(); return true; } }
    : {
      fromTick: shot.fromTick, toTick: shot.toTick, move: shot.move, tick: playback.tick,
      cue: async () => { await playback.seek(shot.fromTick!); return playback.setPlaying(false); },
      play: () => playback.setPlaying(true),
    };
  signal.addEventListener('abort', () => { delete (globalThis as { __soulsShot?: unknown }).__soulsShot; });
  return shot;
}

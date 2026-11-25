// #4153 review fix: when the v2 stream cannot be read, the page says so instead of staying on its loading card.
/** The one notice the page's own status line shows (ViewerFrame treats it like the 3D-unavailable reasons). */
export const STREAM_NOTICE = "This world's stream is not available right now.";
/** #4535: the stream moved to a format this page cannot read; the page reloads for the new one (stream-format.ts). */
export const STREAM_RELOADING = 'A new version of this world is out: reloading.';
/** #4684: the reader is behind and playing the parts it missed; it says so as it goes, so the stream is alive. */
export const STREAM_CATCHING = 'Catching up with this world.';
/** How long without a part (or a catch-up's word), from the start (none yet) or after the last one, before the notice shows. */
export const STREAM_SILENCE_MS = 15_000;

export type StreamHealth = {
  /** The import, the bridge or its start threw. */
  failed: boolean;
  /** The page is reloading for a stream format its bundle cannot read. */
  reloading?: boolean;
  /** The reader's last error, and how many parts had arrived when it was first seen (a later part clears it). */
  error: string | null; errorAtParts: number | null;
  parts: number;
  /** When the stream was started and when the newest part (or catch-up word) arrived (ms, one clock); null before any. */
  startedAt: number; lastPartAt: number | null; now: number;
  /** #4684: the reader is catching up (no part since its latest word). */
  catching?: boolean;
};

/** When the stream last showed life, as the page reads the bridge's view (use-v2-souls.ts): a new part, a later world
 *  time (B2-3: a still world's pointer), or a catch-up's word (#4684). */
export class StreamLife {
  parts = 0; lastPartAt: number | null = null;
  private to: number | null = null;
  private said = 0;
  see(v: { parts: number; newestTo: number | null; catching?: { said: number } }, now: number): void {
    if (v.parts !== this.parts) { this.parts = v.parts; this.lastPartAt = now; }
    if (v.newestTo !== this.to) { this.to = v.newestTo; if (this.to !== null) this.lastPartAt = now; }
    if (v.catching && v.catching.said !== this.said) { this.said = v.catching.said; this.lastPartAt = now; }
  }
}

/** The notice to show, or null: a failure, an error with no part since, no part 15 s after the start, or none for 15 s;
 *  a reader catching up says so. */
export function streamNotice(h: StreamHealth): string | null {
  if (h.reloading) return STREAM_RELOADING;
  if (h.failed) return STREAM_NOTICE;
  if (h.error && h.parts <= (h.errorAtParts ?? h.parts)) return STREAM_NOTICE;
  if (h.now - (h.lastPartAt ?? h.startedAt) >= STREAM_SILENCE_MS) return STREAM_NOTICE;
  return h.catching ? STREAM_CATCHING : null;
}

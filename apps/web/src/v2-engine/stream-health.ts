// #4153 review fix: when the v2 stream cannot be read, the page says so instead of staying on its loading card.
/** The one notice the page's own status line shows (ViewerFrame treats it like the 3D-unavailable reasons). */
export const STREAM_NOTICE = "This world's stream is not available right now.";
/** How long without a part, from the start (none yet) or after the last one, before the notice shows. */
export const STREAM_SILENCE_MS = 15_000;

export type StreamHealth = {
  /** The import, the bridge or its start threw. */
  failed: boolean;
  /** The reader's last error, and how many parts had arrived when it was first seen (a later part clears it). */
  error: string | null; errorAtParts: number | null;
  parts: number;
  /** When the stream was started and when the newest part arrived (ms, one clock); null before any part. */
  startedAt: number; lastPartAt: number | null; now: number;
};

/** The notice to show, or null: a failure, an error with no part since, no part 15 s after the start, or none for 15 s. */
export function streamNotice(h: StreamHealth): string | null {
  if (h.failed) return STREAM_NOTICE;
  if (h.error && h.parts <= (h.errorAtParts ?? h.parts)) return STREAM_NOTICE;
  return h.now - (h.lastPartAt ?? h.startedAt) >= STREAM_SILENCE_MS ? STREAM_NOTICE : null;
}

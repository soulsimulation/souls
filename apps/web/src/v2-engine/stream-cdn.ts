// Where the page reads a world's live stream from (#4159). The stream's files (pointer, bundle headers, baselines, parts)
// are public and the same for every viewer, so a CDN can answer them from its nearest edge and send only its misses on to
// the viewers' origin. That hostname is Cloudflare's, proxied to the host's front door, which sends its `/s/*` to the
// origin (v2/tools/ops/proxy/stream-soul-game.caddy, docs/operations/cdn.md "The stream hostname").
//
// The page reads there only when its inline config names exactly this origin (`v2StreamOrigin`, written by the launcher
// from the cutover binding: tools/world-launcher/cutover.mjs) and the visitor has not asked for the origin with
// `?streamcdn=0`. Anything else reads the same `/s/…/` path from the page's own origin, as before. The world's history
// (`v2History`) stays on the page's origin.

/** The one CDN origin a stream may be read from. A different value in the config is ignored, never followed. */
export const STREAM_CDN = 'https://stream.soul.game';

/** The URL the stream reader starts from: `stream` (a same-origin `/s/…/` path, already checked by `v2Stream`) on the
 *  CDN when the config names it, else `stream` unchanged. */
export function streamReadUrl(stream: string, config: { v2StreamOrigin?: unknown } | undefined, search: string): string {
  if (config?.v2StreamOrigin !== STREAM_CDN || !stream.startsWith('/s/')) return stream;
  return new URLSearchParams(search).get('streamcdn') === '0' ? stream : STREAM_CDN + stream;
}

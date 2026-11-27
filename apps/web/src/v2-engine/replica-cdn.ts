// Where the page loads the new engine's replica from (#4986). The replica (replica.js and the 2.4 MB WASM it loads beside
// itself) is the largest file a new viewer downloads, the same for everyone and immutable by version, so the asset CDN
// can answer it from its nearest edge. The launcher names the CDN's copy (`v2ReplicaCdn`, tools/world-launcher/cutover.mjs:
// only once it has seen both files answer there) beside the copy it serves itself (`v2Replica`). index.html's head
// script (snapshot-prefetch.ts) decides, with replicaAtCdn below: when the CDN's copy is exactly this CDN's address for
// that same version, and the visitor has not asked for the origin with `?replicacdn=0`, it fetches that copy and leaves
// its address on `window.__simReplica`, with the origin's copy after a `#`: `<cdn address>#<origin path>`. The page hands
// that string to the stream worker as it is (early-stream.ts replicaUrl), and the worker loads the CDN's copy, or the
// origin's when the CDN's does not load (replica-served.ts). The decision lives in the head script, not in the page's
// code, so the chunks the page's first phase waits for carry none of it.
// No imports: vite.config.ts loads this file in node, and replicaAtCdn is serialised into index.html as it stands.

/** The one CDN a replica may be loaded from. A different address in the config is ignored, never followed. */
export const REPLICA_CDN = 'https://cdn.soul.game';
/** The window property the head script leaves its decision on: `<cdn address>#<origin path>`. */
export const REPLICA_GLOBAL = '__simReplica';

/** The CDN's copy of the replica the config names (`v2Replica`, by version), else null: none named, another host,
 *  another version, or `?replicacdn=0`. Self-contained and plain: the head script carries its text. */
export function replicaAtCdn(config: { v2Replica?: unknown; v2ReplicaCdn?: unknown } | undefined, search: string): string | null {
  const cdn = config ? config.v2ReplicaCdn : null, named = config ? config.v2Replica : null;
  if (typeof cdn !== 'string' || typeof named !== 'string') return null;
  const m = /^https:\/\/cdn\.soul\.game\/assets\/replica\/([0-9a-f]{16})\/replica\.js$/.exec(cdn), tail = m ? '/v2/replica/' + m[1] + '/replica.js' : '';
  if (!m || named.slice(-tail.length) !== tail || /[?&]replicacdn=0(?:&|$)/.test(search)) return null;
  return cdn;
}

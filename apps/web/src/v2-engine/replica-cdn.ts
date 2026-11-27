// Where the page loads the new engine's replica from (#4986). The replica (replica.js and the 2.3 MB WASM it loads beside
// itself) is the largest file a new viewer downloads, the same for everyone and immutable by version, so the asset CDN
// can answer it from its nearest edge. The launcher names the CDN's copy (`v2ReplicaCdn`, tools/world-launcher/cutover.mjs:
// only once it has seen both files answer there) beside the copy it serves itself (`v2Replica`), and the page reads the
// CDN's only when it is exactly this CDN's address for that same version and the visitor has not asked for the origin
// with `?replicacdn=0`. The worker falls back to the origin's copy when the CDN's does not load (replica-served.ts).
// Small on purpose, and no imports: the page's first phase loads it.

/** The one CDN a replica may be loaded from. A different address in the config is ignored, never followed. */
export const REPLICA_CDN = 'https://cdn.soul.game';

/** The CDN's copy of the replica the config names (`v2Replica`, by version), else null: none named, another host,
 *  another version, or `?replicacdn=0`. Self-contained and plain: the head script carries its text (snapshot-prefetch.ts). */
export function replicaAtCdn(config: { v2Replica?: unknown; v2ReplicaCdn?: unknown } | undefined, search: string): string | null {
  const cdn = config ? config.v2ReplicaCdn : null, named = config ? config.v2Replica : null;
  if (typeof cdn !== 'string' || typeof named !== 'string') return null;
  const m = /^https:\/\/cdn\.soul\.game\/assets\/replica\/([0-9a-f]{16})\/replica\.js$/.exec(cdn), tail = m ? '/v2/replica/' + m[1] + '/replica.js' : '';
  if (!m || named.slice(-tail.length) !== tail || /[?&]replicacdn=0(?:&|$)/.test(search)) return null;
  return cdn;
}

const origins = new Map<string, string>();
/** Remembers the origin's copy of a CDN replica, for the worker's fallback. */
export function keepReplicaOrigin(cdn: string, origin: string): void { origins.set(cdn, origin); }
/** The origin's copy of the replica at `address`, when `address` is the CDN's; else undefined. */
export function replicaOrigin(address: string): string | undefined { return origins.get(address); }

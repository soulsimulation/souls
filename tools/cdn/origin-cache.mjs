// Origin cache rules for immutable responses and mutable asset views (lane CACHE, 2026-10-22). cdn-walk.mjs applies it to every same-origin
// response of a cold page load, so a new immutable class the origin serves without a long-lived cache policy, or one
// Cloudflare will not cache at all, fails the ship walk instead of costing every stranger a trip to eden2.
//   content-addressed (hash in the path: Vite `/assets/<name>-<hash>.<ext>`, `/assets/<sha256>.<ext>`, `/v1/world/part/<hash>`,
//     `/art/<sha256>`, profile photos): `immutable` and max-age >= 30 days;
//   release-stable (same bytes for a build, name not hashed: `/modular`, `/mars-assets`, `/world-assets`, `.wasm`, fonts):
//     max-age >= 1 hour;
//   mutable-view (source identities that may select new renditions): public, no-cache, never immutable;
//     Cloudflare DYNAMIC/BYPASS can occur for these origin validators. Legacy GLB aliases may be mutable core views or
//     immutable uploaded content; their response must satisfy one complete policy.
//   immutable/stable: Cloudflare must be able to cache it (cf-cache-status DYNAMIC or BYPASS is a miss). A first request after a
//     release is a MISS/EXPIRED and is not counted; HIT/REVALIDATED/STALE/UPDATING/MISS/EXPIRED all pass.
// Only 200 responses on the origin host are judged; assets.eden.art has its own checks in cdn-walk.
const DAY = 86400;
const VIEW = /^(?:\/worlds)?(?:\/w\/[a-z][a-z0-9-]{0,31})?\/asset-view\/[0-9a-f]{64}\.glb$/;
const LEGACY_GLB = /^(?:\/worlds)?(?:\/w\/[a-z][a-z0-9-]{0,31})?\/assets\/[0-9a-f]{64}\.glb$/;
const HASHED = [
  /^(?:\/worlds)?\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/,      // Vite content hash (8 chars, base64url)
  /^(?:\/worlds)?(?:\/w\/[a-z][a-z0-9-]{0,31})?\/assets\/[0-9a-f]{64}\.[a-z0-9]+$/, // content-addressed stored objects
  /^(?:\/worlds)?\/w\/[a-z][a-z0-9-]{0,31}\/v1\/world\/part\/[0-9a-f]{16,}$/,
  /\/art\/[0-9a-f]{64}\.[a-z0-9]+$/,
  /\/profile-photo\/[0-9a-f]{16,}$/,
];
const STABLE = [
  /^(?:\/worlds)?\/(?:modular|mars-assets|world-assets)\//,
  /\.(?:wasm|woff2?|ttf|otf)$/i,
];
export function originCacheClass(path) {
  const p = path.split('?')[0];
  if (VIEW.test(p)) return 'mutable-view';
  if (LEGACY_GLB.test(p)) return 'legacy-glb';
  if (HASHED.some((r) => r.test(p))) return 'hashed';
  if (STABLE.some((r) => r.test(p))) return 'stable';
  return null;
}
const maxAge = (cc) => { const m = /(?:^|[,\s])max-age=(\d+)/i.exec(cc ?? ''); return m ? Number(m[1]) : 0; };
const directive = (cc, name) => new RegExp('(?:^|,)\\s*' + name + '\\s*(?:,|$)', 'i').test(cc);
// -> null when fine (or outside the checked classes), else a one-line problem.
export function originCacheProblem({ path, status, headers }) {
  if (status !== 200) return null;
  const cls = originCacheClass(path); if (!cls) return null;
  const cc = headers['cache-control'] ?? '', cf = (headers['cf-cache-status'] ?? '').toUpperCase(), age = maxAge(cc);
  if (/no-store|private/i.test(cc)) return `origin ${cls} asset not publicly cacheable (${cc}): ${path}`;
  const revalidated = cls === 'mutable-view' || cls === 'legacy-glb' && directive(cc, 'no-cache');
  if (revalidated && (!directive(cc, 'public') || !directive(cc, 'no-cache') || directive(cc, 'immutable'))) return `origin mutable asset view without public + no-cache or with immutable (${cc || 'none'}): ${path}`;
  if ((cls === 'hashed' || cls === 'legacy-glb' && !revalidated) && (!directive(cc, 'immutable') || age < 30 * DAY)) return `origin hashed asset without immutable + 30d max-age (${cc || 'none'}): ${path}`;
  if (cls === 'stable' && age < 3600) return `origin release-stable asset with max-age < 1h (${cc || 'none'}): ${path}`;
  if ((cf === 'DYNAMIC' || cf === 'BYPASS') && !revalidated) return `Cloudflare ${cf} for an origin ${cls} asset: ${path}`;
  return null;
}

// The CDN cache rule for soul.game (E2): the paths a shared cache may keep, derived from the classes above (in their
// root-launcher form; soul.game has no /worlds prefix) plus the keyed snapshot (apps/server/src/edge-snapshot.ts). The
// rule only makes a path eligible; the origin's Cache-Control decides (edge TTL "use the header if present, bypass if
// not"), so a no-store, private or header-less answer on an eligible path is never kept. No path that can answer per
// user is listed: the static patterns never match under /v1/ or /__sim/, and the three API reads are public by design
// (moderation-filtered, no auth read). docs/operations/cdn.md carries cdnRuleExpression() verbatim (the test checks).
// A world's public stream, /s/* (#4159), is files the viewers' origin (v2/tools/origin/origin.mjs) serves with one of
// three answers: immutable for a year (parts, baselines, bundle headers), max-age=1 (the pointer, history/live), or a
// no-store 404 (a file not yet written, a query string); the CDN then keeps each file once per edge instead of every
// viewer reaching the origin. Its other routes that Caddy's /s/* also reaches are no-store or private, so never kept.
export const CDN_CACHE_RULE = {
  host: 'soul.game',
  // static files: Vite bundles and content-addressed objects (HASHED 1, 2, 4), release-stable files (STABLE), the stream
  files: ['/assets/*', '/w/*/assets/*', '/w/*/art/*', '/modular/*', '/mars-assets/*', '/world-assets/*', '*.wasm', '*.woff', '*.woff2', '*.ttf', '*.otf', '/s/*'],
  // public reads: snapshot parts (HASHED 3), profile photos (HASHED 5), the snapshot (s-maxage only for the current ?v= key)
  api: ['/w/*/v1/world/part/*', '/w/*/v1/souls/*/profile-photo/*', '/w/*/v1/world/snapshot'],
  never: ['/v1/', '/__sim/'],   // no static pattern matches a path containing these
};
// The CDN's `strict wildcard`: `*` is any run of characters, slashes included; the rest is literal and case-sensitive,
// matched against the whole path without its query string.
const wild = (pattern) => new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const RULE_FILES = CDN_CACHE_RULE.files.map(wild), RULE_API = CDN_CACHE_RULE.api.map(wild);
/** Whether the documented rule makes a path eligible for the CDN's cache (the origin's headers still decide). */
export function cdnCacheEligible(path) {
  const p = path.split('?')[0];
  if (RULE_API.some((r) => r.test(p))) return true;
  return RULE_FILES.some((r) => r.test(p)) && !CDN_CACHE_RULE.never.some((s) => p.includes(s));
}
/** The rule as the CDN's filter expression, exactly as docs/operations/cdn.md gives it. */
export function cdnRuleExpression() {
  const any = (list) => list.map((x) => `http.request.uri.path strict wildcard "${x}"`).join(' or ');
  const not = CDN_CACHE_RULE.never.map((x) => `not http.request.uri.path contains "${x}"`).join(' and ');
  return `http.host eq "${CDN_CACHE_RULE.host}" and ((${any(CDN_CACHE_RULE.api)}) or ((${any(CDN_CACHE_RULE.files)}) and ${not}))`;
}

// The stream hostname (#4159): the eden.art zone is on Cloudflare and soul.game is not, so a world's stream is served to
// viewers from stream.eden.art (v2/tools/ops/proxy/stream-eden-art.caddy), which answers only /s/* and a no-store 404.
// Its rule is the host alone: everything it answers is a stream file whose Cache-Control decides. The page's
// STREAM_ORIGIN (v2/web/src/source/address.ts) names the same host; docs/operations/cdn.md carries the expression.
export const STREAM_HOST = 'stream.eden.art';
export const streamRuleExpression = () => `(http.host eq "${STREAM_HOST}")`;

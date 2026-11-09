// LOAD-CONTRACT §2: the request class of a world route, as in-world admission sees it (admission.ts). Dependency-free, so
// the launcher shares it (#459: it answers a Soul the world asked to wait only on exactly the routes the world admits).
export type Cls = 'C0' | 'C1' | 'C2' | 'C3';
export type RouteClass = {cls: Cls; id: string; god: boolean; deadlineMs: number};

const C1_MS = 20_000, GOD_C1_MS = 30_000, C2_MS = 8_000;
const EDGE_READ = /^\/v1\/edge\/(here|observe|capabilities|view|objects(?:\/[^/]+)?)$/;
const EDGE_WRITE = /^\/v1\/edge\/(act|say|converse|objects\/[^/]+\/act|plan(?:\/[^/]+)?)$/;
const PUBLIC = /^\/v1\/(?:edge\/(?:map|rides|items|platforms)|world\/snapshot)$/;
const GOD_READ = /^\/v1\/god\/(mirror|doctor|trace|recommend|layers|layers\/zone-suggest|defs\/unused)$/;
const GOD_FREE = /^\/v1\/god\/(?:pair\/|claim$|answer$|inbox\/|pray$|assets$|visitors$)/;   // auth flows, uploads, Souls' prayers
/** The request class of a route (§2); null = not admitted here (passes straight through). Paths are world-relative. */
export function classify(method: string, path: string): RouteClass | null {
  if (path === '/healthz' || path === '/v1/config') return {cls: 'C0', id: path, god: false, deadlineMs: 0};
  if (PUBLIC.test(path)) return method === 'GET' ? {cls: 'C3', id: path, god: false, deadlineMs: 0} : null;
  let m: RegExpExecArray | null;
  if (path.startsWith('/v1/edge/')) {
    // `around` explores: it records the places found and invalidates menus (around.ts), so it is a write (C1), not a read
    if (method === 'GET' && path === '/v1/edge/around') return {cls: 'C1', id: 'edge:around', god: false, deadlineMs: C1_MS};
    if (method === 'GET' && (m = EDGE_READ.exec(path))) return {cls: 'C2', id: 'edge:' + m[1].replace(/\/.*/, '/:id'), god: false, deadlineMs: C2_MS};
    if (method === 'POST' && path === '/v1/edge/resolve') return {cls: 'C2', id: 'edge:resolve', god: false, deadlineMs: C2_MS};
    if (method !== 'GET' && (m = EDGE_WRITE.exec(path))) return {cls: 'C1', id: 'edge:' + m[1].replace(/\/[^/]+/, '/:id'), god: false, deadlineMs: C1_MS};
    return null;
  }
  if (path.startsWith('/v1/god/')) {
    if (method === 'GET' && (m = GOD_READ.exec(path))) return {cls: 'C2', id: 'god:' + m[1], god: true, deadlineMs: C2_MS};
    if (method === 'POST' && path === '/v1/god/query') return {cls: 'C2', id: 'god:query', god: true, deadlineMs: C2_MS};
    if (method !== 'GET' && !GOD_FREE.test(path)) return {cls: 'C1', id: 'god:' + path.slice(8).replace(/\/[0-9a-z_-]{8,}(?=\/|$)/gi, '/:id'), god: true, deadlineMs: GOD_C1_MS};
    return null;
  }
  return null;
}

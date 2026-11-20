// An installed world's address is its own trusted bootstrap, never a public query naming a bearer destination.
export type WorldAddress = { world: string; stream: string; history?: string; directory: string; gateway: string; creatorToken: string };
const WORLD = /^\/(preview\/)?w\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/;
const local = (u: URL) => u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(u.hostname));

export async function worldAddress(href: string, get: typeof fetch = fetch): Promise<WorldAddress | null> {
  const at = new URL(href), match = WORLD.exec(at.pathname);
  if (!match) return null;
  const base = `/${match[1] ?? ''}w/${match[2]}`;
  const res = await get(new URL(`${base}/v1/bootstrap`, at).href, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
  if (!res.ok) throw new Error(`world routing refused: ${res.status}`);
  const data = await res.json() as WorldAddress;
  const stream = (p: unknown) => typeof p === 'string' && /^\/s\/[A-Za-z0-9._/-]+\/$/.test(p) && !p.split('/').some(s => s === '.' || s === '..');
  if (data.world !== match[2] || !stream(data.stream) || (data.history !== undefined && !stream(data.history)) || data.directory !== '/' || data.gateway !== `${base}/v2/ws` || data.creatorToken !== `${base}/v2/creator-token`) throw new Error('world routing is invalid');
  return { world: data.world, stream: new URL(data.stream, at).href, ...(data.history ? { history: new URL(data.history, at).href } : {}), directory: at.origin, gateway: new URL(data.gateway, at.href.replace(/^http/, 'ws')).href, creatorToken: new URL(data.creatorToken, at).href };
}

/** Explicit development endpoints remain local to an HTTP-loopback page; public pages ignore these parameters. */
export function localAddresses(href: string): { directory: string | null; gateway: string | null } {
  const at = new URL(href);
  if (!local(at)) return { directory: null, gateway: null };
  const q = at.searchParams, directory = q.get('directory'), gateway = q.get('gateway');
  if (directory) {
    const u = new URL(directory, at);
    if (!local(u) || u.username || u.password || u.search || u.hash) throw new Error('local directory must be HTTP loopback');
  }
  if (gateway) {
    const u = new URL(gateway, at.href.replace(/^http/, 'ws'));
    if (u.protocol !== 'ws:' || !local(new URL(u.href.replace(/^ws:/, 'http:'))) || u.username || u.password || u.search || u.hash) throw new Error('local gateway must be WS loopback');
  }
  return { directory, gateway };
}

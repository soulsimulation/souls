// Shared public world-address contract for pairing and migration.

/**
 * A world's public URL selects its own gateway path. Explicit gateway queries are local development only.
 */
export function worldOf(text) {
  let u;
  try { u = new URL(text); } catch { throw Object.assign(new Error('pair <world url>, as https://host/<world>'), { code: 'pair-names-a-world' }); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw Object.assign(new Error('name an HTTP world URL'), { code: 'pair-names-a-world' });
  const installed = /^\/(preview\/)?w\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/.exec(u.pathname);
  const world = installed?.[2] ?? u.pathname.split('/').filter(Boolean)[0] ?? 'world';
  const base = installed ? `/${installed[1] ?? ''}w/${world}` : '';
  const socket = new URL(`${base}/v2/ws`, u.href.replace(/^http/, 'ws'));
  const local = (at) => at.protocol === 'http:' && (at.hostname === 'localhost' || at.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(at.hostname));
  const explicit = !installed && local(u) && u.searchParams.get('gateway');
  if (explicit) {
    const target = new URL(explicit);
    if (target.protocol !== 'ws:' || !local(new URL(target.href.replace(/^ws:/, 'http:'))) || target.username || target.password || target.search || target.hash) throw Object.assign(new Error('local gateway must be WS loopback'), { code: 'pair-names-a-world' });
    socket.href = target.href;
  }
  const gateway = socket.href;
  return { directory: u.origin, world, gateway };
}

/** Canonical/preview addresses must confirm the same-origin installed bootstrap before any pairing request. */
export async function pairAddress(text, get = fetch) {
  const address = worldOf(text), at = new URL(text);
  const match = /^\/(preview\/)?w\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/.exec(at.pathname);
  if (!match) return address;
  const base = `/${match[1] ?? ''}w/${match[2]}`;
  const bootstrap = `${at.origin}${base}/v1/bootstrap`;
  let res, data;
  try {
    res = await get(bootstrap, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (res.redirected || (res.url && res.url !== bootstrap)) throw new Error('redirected bootstrap');
    if (res.ok) data = await res.json();
  } catch { throw Object.assign(new Error('world bootstrap is unavailable or invalid; the home is unchanged'), { code: 'pair-world-routing' }); }
  if (!res.ok) throw Object.assign(new Error(`world bootstrap refused: ${res.status}`), { code: 'pair-world-routing' });
  if (data?.world !== address.world || data.directory !== '/' || data.gateway !== `${base}/v2/ws`) throw Object.assign(new Error('world bootstrap is invalid'), { code: 'pair-world-routing' });
  return address;
}

/**
 * The world's public name, as its own record gives it (`<origin>/w/<world>/v1/config` `worldName`, what the world page's
 * title shows), or null when it does not answer. First day, 27 Nov: the home's guide named the world by its address key
 * (`in eden`) while the page said "Eden 2026", and an agent could not tell whether they were one world. Plain words only.
 */
export async function worldNameOf(directory, world, { get = fetch, within = 3000 } = {}) {
  try {
    const r = await get(new URL(`w/${encodeURIComponent(world)}/v1/config`, `${new URL(directory).origin}/`).href,
      { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(within) });
    if (!r.ok) return null;
    const n = (await r.json())?.worldName;
    const name = typeof n === 'string' ? n.replace(/[^\p{L}\p{N} '.,!&()-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    return name || null;
  } catch {
    return null;
  }
}

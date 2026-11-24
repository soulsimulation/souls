// The launcher's copy of apps/server/src/address-key.ts (0.134 D2: the launcher imports nothing from the old world server).
// #2543 (Scaling H7): what "the same address" means for every per-address limit. An IPv4 address is itself; an IPv6
// address counts by its /64 (one customer network: 2^64 addresses a client could rotate through, one per request); an
// IPv4-mapped IPv6 address is the IPv4 address it carries. A value that is not an address stays as it is, trimmed: a
// client that could write junk there could as well write fresh IPv4 addresses, so folding junk together would bound
// nothing. IPv4 is never widened: mobile carriers put many people behind one IPv4 address.
import { isIP } from 'node:net';

/** The address a forwarded value names, trimmed: a header value (`x-forwarded-for`, a comma list: the first entry, the
 *  visitor the proxy saw, unless `hop: 'last'` asks for the nearest proxy hop), or a socket's peer address. `null`
 *  when empty. What a limit keys on is addressKey(); this is the address itself (`/__sim/whoami` reports it). */
export function forwardedAddress(forwarded, { hop = 'first' } = {}) {
  const list = (Array.isArray(forwarded) ? forwarded.join(',') : String(forwarded ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  return (hop === 'last' ? list.at(-1) : list[0]) ?? null;
}

/** The key every per-address limit counts under, for the address forwardedAddress() names. `null` when empty. */
export function addressKey(forwarded, opts = {}) {
  const a = forwardedAddress(forwarded, opts);
  if (!a) return null;
  if (isIP(a) !== 6) return a;
  const g = groups(a.split('%')[0].toLowerCase());
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, a dotted IPv4 tail as two groups). */
function groups(a) {
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  const s = tail ? `${a.slice(0, tail.index)}${((+tail[1] << 8) | +tail[2]).toString(16)}:${((+tail[3] << 8) | +tail[4]).toString(16)}` : a;
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [], r = rest ? rest.split(':') : [];
  const all = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  return all.map((x) => parseInt(x, 16));
}

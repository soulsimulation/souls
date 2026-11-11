// #1972: the raw-HTTP client Soul of #1945 (bench.mjs --load client), for the meetup and slopes benches. A Soul fetches
// the catalog and the live picture once, then acts by catalog id (strict, keyed: the key is also the clientRef), reads
// that act's receipt once and waits. Headers and retry rules are the client's (eden.mjs call()): a designed busy or
// stalled answer is waited out for its Retry-After (up to 20 % more) at most 3 times; no answer gets full-jitter backoff
// (1 s base, 60 s cap, 6 tries), 25 s per read try and 40 s per act try. No call goes to the resolver.
// The pacing of the `real` profile is the committed cadence file of #1945 (../profiles/cadence.json), read once here.
import { readFileSync } from 'node:fs';

export const CLIENT_HEADER = 'bench/1';
export const CADENCE = Object.freeze(JSON.parse(readFileSync(new URL('../profiles/cadence.json', import.meta.url), 'utf8')));
export const BUSY_CODES = new Set(['world.busy', 'soul.busy', 'soul.slow-down', 'world.starting', 'world.crowded', 'rate-limited', 'client.rate', 'account.rate']);
export const STALL_CODES = new Set(['unavailable', 'world.unavailable', 'world-unavailable', 'world.stalled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** The client's headers: its own address and `x-soul-client`; the token unless the read is public; a key on an act. */
export const clientHeaders = ({ token, address }, { auth = true, key = null } = {}) => ({ 'content-type': 'application/json', 'x-soul-client': CLIENT_HEADER,
  ...(address ? { 'x-forwarded-for': address } : {}), ...(auth && token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) });
/** An act by catalog id: strict (offered ids only), keyed; the key is also the clientRef. */
export const actBody = (id, key) => ({ capability: id, params: {}, strict: true, clientRef: key });

function retryAfterMs(r, d) {
  const h = r.headers.get('retry-after'), n = Number(h); if (h && Number.isFinite(n) && n >= 0) return n * 1000;
  for (const v of [d?.world?.retry_after_s, d?.error?.retry_after_s, d?.retry_after_s, d?.error?.retry_after, d?.retry_after]) if (Number.isFinite(v) && v >= 0) return v * 1000;
  return null;
}
/** One call with the client's retry rules. `jitter` is the caller's [0,1) source (seeded in the meetup bench). The
 *  optional `deadlineMs` and `signal` end the call early (status -1). → {status, code, data, bytes, busy, failed,
 *  waitMs, refusals}: status -1 timed out, 0 nothing answered. */
export async function clientCall(url, { method = 'GET', headers, body, jitter = Math.random, deadlineMs = Infinity, signal = null } = {}) {
  const t = performance.now(), tryMs = method === 'GET' ? 25_000 : 40_000, refusals = [];
  let status = 0, code = null, data = null, bytes = 0, busy = 0, failed = 0, waitMs = 0;
  const wait = async (ms) => { const w0 = performance.now(); await sleep(Math.min(ms, deadlineMs - (performance.now() - t))); waitMs += performance.now() - w0; };
  for (;;) {
    const left = deadlineMs - (performance.now() - t); if (left <= 0 || signal?.aborted) { status = -1; break; }
    let r;
    // #2077: AbortSignal.timeout takes whole milliseconds. Once a call had run past its deadline less one try (a slow
    // first answer, a busy wait), `left` was fractional, every later try threw a RangeError before any request went out,
    // and the call ended with status 0 ("unreachable") though the world was never asked again.
    try {
      r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([AbortSignal.timeout(Math.ceil(Math.min(left, tryMs))), ...(signal ? [signal] : [])]) });
      const text = await r.text(); bytes = Buffer.byteLength(text); status = r.status; try { data = JSON.parse(text); } catch { data = null; }
    } catch (e) {
      if (++failed >= 6 || signal?.aborted) { status = e?.name === 'TimeoutError' || signal?.aborted ? -1 : 0; break; }
      await wait(jitter() * Math.min(60_000, 1000 * 2 ** (failed - 1))); continue;
    }
    code = data?.error?.code ?? data?.code ?? null;
    const later = ((status === 503 || status === 429) && BUSY_CODES.has(code)) || (status >= 500 && STALL_CODES.has(code));
    if (later) refusals.push(code);
    if (later && busy < 3) { busy++; const ra = retryAfterMs(r, data); await wait(Math.min(60_000, ra ?? Math.max(1000, jitter() * Math.min(60_000, 1000 * 2 ** (busy + 1)))) * (1 + 0.2 * jitter())); continue; }
    break;
  }
  return { status, code, data, bytes, busy, failed, waitMs: Math.round(waitMs), refusals };
}
/** The Soul's start: the public catalog and the live picture, once each. → the catalog (null when it did not answer). */
export async function startPicture(base, soul) {
  const cat = await clientCall(`${base}/v1/edge/catalog`, { headers: clientHeaders(soul, { auth: false }) });
  const live = await clientCall(`${base}/v1/edge/live`, { headers: clientHeaders(soul, { auth: false }) });
  return { catalog: cat.status === 200 ? cat.data : null, catalogStatus: cat.status, liveStatus: live.status };
}

/** Catalog ids by act kind, as bench.mjs reads them: the walks (buildings first, then other open places), the spots, and
 *  the kinds of the profiles' mixes. A kind the world does not offer has no ids; the caller sends a walk and counts it. */
export function catalogIds(cat) {
  const walkOf = (p) => `walk:${p.ref ?? p.id}`, spots = (cat?.acts ?? []).filter((a) => !a.with && !a.needs), verb = (v) => spots.filter((a) => a.verb === v).map((a) => a.id);
  const walks = [...(cat?.places ?? []).filter((p) => p.kind === 'building'), ...(cat?.places ?? []).filter((p) => p.kind !== 'building' && !p.fixed && !p.parent)].map(walkOf);
  return { walk: walks, spot: spots.map((a) => a.id), 'sit-ground': ['sit-ground:here'], sit: [...verb('sit'), ...(cat?.things ?? []).filter((t) => t.seat).map((t) => `sit:${t.id}`)],
    read: verb('read'), eat: verb('eat'), 'play-music': verb('play-music'), swim: verb('swim') };
}

// ------------------------------------------------------------------ pacing (cadence.json), deterministic given u in [0,1)
const fromQuantiles = (q, u) => { for (let i = 1; i < q.length; i++) if (u <= q[i][0]) { const [p0, v0] = q[i - 1], [p1, v1] = q[i]; return v0 + (v1 - v0) * (u - p0) / (p1 - p0); } return q.at(-1)[1]; };
/** Act start to act start, ms: inverse CDF over the profile's quantiles, or uniform. */
export const gapMs = (cad, u) => { const g = cad.gapS; return 1000 * (g.uniform ? g.uniform[0] + u * (g.uniform[1] - g.uniform[0]) : fromQuantiles(g.quantiles, u)); };
/** Window start to the first act, ms (the instruction-to-first-act quantiles; else a uniform share of one gap). */
export const firstMs = (cad, u) => (cad.firstActS ? 1000 * fromQuantiles(cad.firstActS.quantiles, u) : u * gapMs(cad, 0.5));
/** An act kind drawn from the profile's mix by weight. */
export function kindOf(cad, u) {
  const mix = Object.entries(cad.mix); let x = u * mix.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of mix) if ((x -= w) < 0) return k;
  return mix.at(-1)[0];
}

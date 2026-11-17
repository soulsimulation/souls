#!/usr/bin/env node
// Checks soul.game behind the CDN from outside (#2513; the site file is soul-game.caddy beside this script, the trusted
// ranges cdn-trust.snippet):
//   SOUL_CHECK_TOKEN=<a scratch Soul's token> node tools/world-launcher/deploy/caddy/check-soul-game.mjs \
//     [--origin https://soul.game] [--world eden] [--trace <origin>/cdn-cgi/trace] [--stable <path>] [--points a,b]
// Seven points (the CLI runs all; checkSoulGame's default is the first six), each PASS or a PROBLEM naming it:
//   address  /__sim/whoami (the address the launcher keyed this request on) equals the ip= line of the CDN's trace page
//   forged   the same with a forged X-Forwarded-For: the same answer, never the forged value
//   viewer   a viewer WebSocket (/w/<world>/ws?hello=...) receives its welcome
//   agent    a request with no browser headers to /__sim/healthz, and a POST to /w/<world>/v1/edge/act, are answered by
//            the launcher (JSON, no CDN challenge)
//   events   the first event of /w/<world>/v1/edge/events arrives within --event-ms (the token is read from the
//            environment only, so it stays out of shell history and process lists)
//   ranges   the static ranges in cdn-trust.snippet equal the CDN's published lists
//   cache    the cache rule (docs/operations/cdn.md): the world page's script bundle, its first snapshot part, a
//            release-stable file (--stable) and the snapshot under the page's own key, each requested twice, the
//            second a CDN hit; the snapshot under a stale key is no-store and never a hit
// Read-only: GETs, one WebSocket join, and one POST without a token that the launcher refuses before any world reads it.
// Exit 0 on PASS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const POINTS = ['address', 'forged', 'viewer', 'agent', 'events', 'ranges'];
export const PUBLISHED = ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'];
export const FORGED = '203.0.113.77';   // a documentation address (RFC 5737): no visitor has it
const SNIPPET = fileURLToPath(new URL('./cdn-trust.snippet', import.meta.url));
const UA = 'souls-check-soul-game';
const STABLE = '/mars-assets/draco/draco_decoder.wasm';   // every world page loads it (LiveWorld's Draco decoder)

/** The ranges on the snippet's `trusted_proxies static <ranges...>` line (Caddy takes them as arguments of one line). */
export function staticRanges(text) {
  const m = /^\s*trusted_proxies\s+static\s+([^\n#]+)/m.exec(text);
  return m ? m[1].trim().split(/\s+/) : [];
}

/** A CDN challenge or block page instead of the launcher's answer. */
const challenged = (r) => r.headers.get('cf-mitigated') ? `challenged (cf-mitigated: ${r.headers.get('cf-mitigated')})` : null;
const isJson = (r) => /application\/json/.test(r.headers.get('content-type') ?? '');

export async function checkSoulGame({ origin = 'https://soul.game', world = 'eden', trace, token, snippet = SNIPPET, published = PUBLISHED, points = POINTS, stable = STABLE, eventMs = 5000, waitMs = 10_000, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const problems = [], seen = [];
  const bad = (point, message) => problems.push(`${point}: ${message}`);
  const get = (url, init = {}) => fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(waitMs), ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } });
  const whoami = async (headers) => { const r = await get(`${origin}/__sim/whoami`, { headers }); const why = challenged(r); if (why) throw Error(why); if (r.status !== 200 || !isJson(r)) throw Error(`/__sim/whoami answered ${r.status} ${r.headers.get('content-type') ?? ''}`); return (await r.json()).address ?? null; };
  let keyed;
  const run = { address: async () => {
    const r = await get(trace ?? `${origin}/cdn-cgi/trace`), body = await r.text(), ip = /^ip=(.+)$/m.exec(body)?.[1]?.trim();
    if (!ip) return bad('address', `the CDN's trace page has no ip= line (${r.status}): is the name proxied?`);
    keyed = await whoami();
    seen.push(`address: the CDN saw ${ip}, the launcher keyed ${keyed}`);
    if (keyed !== ip) bad('address', `the launcher keyed ${keyed ?? 'no address'}, the CDN saw ${ip}`);
  }, forged: async () => {
    keyed ??= await whoami();
    const a = await whoami({ 'x-forwarded-for': FORGED });
    seen.push(`forged: with X-Forwarded-For ${FORGED} the launcher keyed ${a}`);
    if (a === FORGED) bad('forged', `the launcher keyed the forged X-Forwarded-For ${FORGED}`);
    else if (a !== keyed) bad('forged', `the launcher keyed ${a ?? 'no address'} with a forged X-Forwarded-For, ${keyed} without`);
  }, viewer: async () => {
    if (typeof WebSocketImpl !== 'function') return bad('viewer', 'no WebSocket in this Node');
    const url = `${origin.replace(/^http/, 'ws')}/w/${world}/ws?hello=${encodeURIComponent(JSON.stringify({ t: 'hello', proto: 1 }))}`, t0 = performance.now();
    const got = await new Promise((yes) => {
      const ws = new WebSocketImpl(url), done = (v) => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } yes(v); };
      const timer = setTimeout(() => done(`no welcome in ${waitMs} ms`), waitMs);
      ws.onmessage = (e) => { if (typeof e.data !== 'string') return; try { if (JSON.parse(e.data).t === 'welcome') done(null); } catch { /* not JSON */ } };
      ws.onerror = () => done('the socket failed to open (refused, challenged or not upgraded)');
      ws.onclose = (e) => done(`closed before the welcome (${e.code})`);
    });
    seen.push(`viewer: ${got ?? `welcome in ${Math.round(performance.now() - t0)} ms`}`);
    if (got) bad('viewer', got);
  }, agent: async () => {
    const h = await get(`${origin}/__sim/healthz`), hb = isJson(h) ? await h.json() : (await h.text(), null);
    seen.push(`agent: GET /__sim/healthz -> ${h.status} ${h.headers.get('content-type') ?? ''}`);
    const why = challenged(h);
    if (why || h.status !== 200 || hb?.ok !== true) bad('agent', `GET /__sim/healthz: ${why ?? `${h.status}${hb ? '' : ' not JSON'}`}, want 200 {ok:true}`);
    const p = await get(`${origin}/w/${world}/v1/edge/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const pb = isJson(p) ? await p.json() : (await p.text(), null), pwhy = challenged(p);
    seen.push(`agent: POST /w/${world}/v1/edge/act -> ${p.status} ${pb?.code ?? p.headers.get('content-type') ?? ''}`);
    if (pwhy || !pb) bad('agent', `POST /w/${world}/v1/edge/act: ${pwhy ?? `${p.status} not JSON`}, want the launcher's own JSON answer`);
  }, events: async () => {
    if (!token) return bad('events', 'no Soul token: set SOUL_CHECK_TOKEN to a scratch Soul\'s token');
    const ac = new AbortController(), t0 = performance.now(), timer = setTimeout(() => ac.abort(), eventMs);
    try {
      const r = await fetchImpl(`${origin}/w/${world}/v1/edge/events`, { headers: { 'user-agent': UA, accept: 'text/event-stream', authorization: `Bearer ${token}` }, signal: ac.signal });
      if (r.status !== 200 || !/text\/event-stream/.test(r.headers.get('content-type') ?? '')) { await r.body?.cancel(); return bad('events', `${challenged(r) ?? r.status} ${r.headers.get('content-type') ?? ''}, want 200 text/event-stream`); }
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        // the first event: an event: or data: line (a ": " line is a comment, a heartbeat)
        if (/^(event|data):/m.test(buf)) { const ms = Math.round(performance.now() - t0); seen.push(`events: first event in ${ms} ms`); return; }
      }
      bad('events', 'the stream ended before its first event');
    } catch (e) { bad('events', ac.signal.aborted ? `no first event in ${eventMs} ms (buffered on the way?)` : e.message); }
    finally { clearTimeout(timer); ac.abort(); }
  }, ranges: async () => {
    const mine = new Set(staticRanges(readFileSync(snippet, 'utf8'))), theirs = new Set();
    for (const u of published) { const r = await get(u); if (!r.ok) return bad('ranges', `${u}: ${r.status}`); for (const l of (await r.text()).split('\n')) if (l.trim()) theirs.add(l.trim()); }
    const missing = [...theirs].filter((x) => !mine.has(x)), extra = [...mine].filter((x) => !theirs.has(x));
    seen.push(`ranges: ${mine.size} in the snippet, ${theirs.size} published`);
    if (missing.length) bad('ranges', `published but not trusted: ${missing.join(' ')}`);
    if (extra.length) bad('ranges', `trusted but no longer published: ${extra.join(' ')}`);
  }, cache: async () => {
    // what a first visit fetches, each twice: the second must be an edge hit (one edge site: the hit rate elsewhere is
    // not shown here). Then the snapshot with a key that is not current: never kept.
    const page = await get(`${origin}/w/${world}/`, { headers: { accept: 'text/html' } }), html = await page.text();
    if (page.status !== 200) return bad('cache', `the world page answered ${page.status}`);
    const key = /__simSnapshotKey=("[0-9.]+")/.exec(html)?.[1], part = /__simSnapshotParts=\["([0-9a-f]{32})"/.exec(html)?.[1];
    const snapshot = `/w/${world}/v1/world/snapshot?defs=ref&cols=1&v=`;
    const targets = { bundle: /<script[^>]+src="((?:\/w\/[^/"]+)?\/assets\/[^"?#]+\.js)"/.exec(html)?.[1], part: part && `/w/${world}/v1/world/part/${part}`, stable, snapshot: key && snapshot + encodeURIComponent(JSON.parse(key)) };
    const twice = async (path) => { const st = []; for (let i = 0; i < 2; i++) { const r = await get(origin + path); await r.arrayBuffer(); st.push({ status: r.status, cf: r.headers.get('cf-cache-status') ?? 'none', cc: r.headers.get('cache-control') ?? '' }); } return st; };
    for (const [what, path] of Object.entries(targets)) {
      if (!path) { bad('cache', `the world page names no ${what}`); continue; }
      const [a, b] = await twice(path);
      seen.push(`cache: ${what} ${path}: ${a.status} ${a.cf}, then ${b.status} ${b.cf}`);
      if (b.status !== 200 || b.cf.toUpperCase() !== 'HIT') bad('cache', `${what} ${path}: the second request was ${b.status} ${b.cf}, want 200 HIT`);
    }
    const [a, b] = await twice(snapshot + '0');
    seen.push(`cache: stale snapshot key: ${b.status} ${b.cf} ${b.cc}`);
    if (![a, b].every((x) => /no-store/i.test(x.cc)) || b.cf.toUpperCase() === 'HIT') bad('cache', `the snapshot with a stale key answered ${b.cf} (${b.cc || 'no cache-control'}), want no-store and never a hit`);
  } };
  for (const p of points) { try { await run[p](); } catch (e) { bad(p, e.message); } }
  return { pass: problems.length === 0, problems, seen };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const r = await checkSoulGame({ origin: opt('--origin', 'https://soul.game').replace(/\/$/, ''), world: opt('--world', 'eden'), trace: opt('--trace'), token: process.env.SOUL_CHECK_TOKEN, eventMs: Number(opt('--event-ms', 5000)), stable: opt('--stable', STABLE), points: opt('--points')?.split(',') ?? [...POINTS, 'cache'] });
  for (const s of r.seen) console.log(`  ${s}`);
  for (const p of r.problems) console.log(`  PROBLEM ${p}`);
  console.log(r.pass ? 'PASS' : 'FAIL');
  process.exitCode = r.pass ? 0 : 1;
}

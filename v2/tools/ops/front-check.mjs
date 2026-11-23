#!/usr/bin/env node
// Checks the front door from outside (Engine v2 O19, #2830; the site files are in proxy/ beside this script):
//   node v2/tools/ops/front-check.mjs --v2 <a world the directory lists> --today <a world only today's system serves> \
//     [--public https://soul.game] [--primary https://sim.eden.art] [--old https://souls.game] [--alias old=slug,...] \
//     [--unlisted <slug>] [--stream /s/<stream>/] [--points a,b] [--stopped <path>] [--map https://name=http://address,...]
// Since 0.132 Core (F4) the front door keeps the old home: today's launcher serves every page, a switched world's included,
// and only streams, a switched world's gateway and pairing reach the new system.
// Points (all but `poster` by default), each PASS or a PROBLEM naming it:
//   worlds   /w/<v2>/ and /w/<today>/ are today's pages; /w/<v2>/v1/edge/ (an old API path) is today's, never redirected
//   client   each world's eden.mjs and /v1/config answer 200 from today's launcher (it serves a switched world's client)
//   aliases  each old alias, at /w/<old>/ and /worlds/w/<old>/, is a same-origin 308 to /w/<slug>/ keeping the query, and
//            lands on today's page
//   domains  the primary and each older domain send GET/HEAD (301) and POST (308) to the public name, path and query kept
//   sign-in  the primary's /sign-in bridge answers (200, no-store, its own CSP) for a return to /w/<v2>/ and to the home
//            page's own sign-in link, refuses a return elsewhere, and the return page opens on the public name
//   headers  pages refuse framing by other sites; API answers are noindex; a CSP with a fetch directive allows the counter
//   robots   robots.txt names the sitemap; the sitemap is today's, lists --today and not --unlisted
//   list     / (the home), /v1/worlds, /v1/auth/config and /v1/account/session are today's
//   address  a forged X-Forwarded-For is never the address today's launcher keys a request on
//   site     /changelog, /changelog.md, /v1/feed and /ops answer from today's launcher
//   stream   <stream>pointer (--stream, default /s/<v2>/) answers 200 from the new system
//   gateway  /w/<v2>/v2/ws reaches the new system's agents' relay; /w/<today>/v2/ws stays with today's launcher
//   pairing  /pair is the new system's pairing card; /v1/pair/* and /v1/agent/account reach the new system
//   poster   (asked for) --stopped, a page behind a stopped origin, shows "back in a moment" as 503 with Retry-After
// --map reaches a name at another address (a local stand-in); redirects are still checked against the names.
// Read-only: GETs and HEADs, plus a POST to an unknown path that each older domain redirects before anything reads it.
// Exit 0 on PASS.
import { isMain } from '../../../tools/lib/is-main.mjs';
import { createHash } from 'node:crypto';
import { signInHref } from '../../web/src/home/list.ts';

export const POINTS = ['worlds', 'client', 'aliases', 'domains', 'sign-in', 'headers', 'robots', 'list', 'address', 'site', 'stream', 'gateway', 'pairing'];
const UA = 'souls-front-check';
const FORGED = '203.0.113.77';   // a documentation address (RFC 5737): no visitor has it
const COUNTER = 'goatcounter.com';

export async function frontCheck({ public: pub = 'https://soul.game', primary = 'https://sim.eden.art', old = ['https://souls.game'], v2, today, aliases = [], unlisted, stream, points = POINTS, stopped, map = {}, fetchImpl = fetch } = {}) {
  const problems = [], seen = [];
  const bad = (point, message) => problems.push(`${point}: ${message}`);
  const reach = (url) => { for (const [name, at] of Object.entries(map)) if (url.startsWith(name)) return at + url.slice(name.length); return url; };
  const get = (url, init = {}) => fetchImpl(reach(url), { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } });
  const page = (path) => get(pub + path, { headers: { accept: 'text/html' } });
  const system = (r) => r.headers.get('x-souls-system') ?? 'unknown';
  const json = async (url) => { const r = await get(url, { headers: { accept: 'application/json' } }); return r.ok ? r.json() : (await r.body?.cancel(), null); };
  const done = async (r) => { await r.arrayBuffer().catch(() => {}); return r; };

  const run = {
    worlds: async () => {
      for (const [slug, flag] of [[v2, 'v2'], [today, 'today']]) {
        const want = 'today';
        if (!slug) { bad('worlds', `no --${flag} world named`); continue; }
        const r = await done(await page(`/w/${slug}/?from=check`));
        seen.push(`worlds: /w/${slug}/ -> ${r.status} ${system(r)}`);
        if (r.status !== 200 || system(r) !== want) bad('worlds', `/w/${slug}/ answered ${r.status} from ${system(r)}, want 200 from ${want}`);
      }
      if (v2) {
        const r = await done(await get(`${pub}/w/${v2}/v1/edge/`));
        seen.push(`worlds: old API /w/${v2}/v1/edge/ -> ${r.status} ${system(r)}`);
        if (r.status >= 300 && r.status < 400) bad('worlds', `/w/${v2}/v1/edge/ redirected (${r.status}), want today's own answer`);
        if (system(r) !== 'today') bad('worlds', `/w/${v2}/v1/edge/ answered by ${system(r)}, want today's launcher`);
      }
    },
    client: async () => {
      if (!v2) return bad('client', 'no --v2 world named');
      // The stopped-launcher run checks only the new system; the full run checks both worlds' client files.
      for (const slug of [v2, today].filter(Boolean)) for (const path of ['eden.mjs', 'v1/config']) {
        const r = await done(await get(`${pub}/w/${slug}/${path}`));
        seen.push(`client: /w/${slug}/${path} -> ${r.status} ${system(r)}`);
        if (r.status !== 200 || system(r) !== 'today') bad('client', `/w/${slug}/${path} answered ${r.status} from ${system(r)}, want 200 from today`);
      }
    },
    aliases: async () => {
      if (!aliases.length) return seen.push('aliases: none named');
      for (const [from, to] of aliases) {
        for (const path of [`/w/${from}/`, `/worlds/w/${from}/`]) {
          const r = await done(await page(`${path}?view=map`)), loc = r.headers.get('location');
          const at = loc ? new URL(loc, pub + path) : null, want = `${pub}/w/${to}/?view=map`;
          seen.push(`aliases: ${path}?view=map -> ${r.status} ${loc ?? ''}`);
          if (r.status !== 308 || at?.href !== want) { bad('aliases', `${path}: ${r.status} to ${at?.href ?? 'nowhere'}, want 308 to ${want}`); continue; }
          const land = await done(await page(at.pathname + at.search)), wantSys = 'today';
          if (land.status !== 200 || system(land) !== wantSys) bad('aliases', `${at.pathname} answered ${land.status} from ${system(land)}, want 200 from ${wantSys}`);
        }
      }
    },
    domains: async () => {
      for (const d of [primary, ...old]) {
        for (const [method, path, status] of [['GET', `/w/${v2 ?? 'eden'}/?view=map&x=1`, 301], ['HEAD', '/', 301], ['POST', '/w/x/v1/front-check', 308]]) {
          let r; try { r = await done(await get(d + path, { method })); } catch (e) { bad('domains', `${method} ${d}${path}: ${e.message}`); continue; }
          const loc = r.headers.get('location');
          seen.push(`domains: ${method} ${d}${path} -> ${r.status} ${loc ?? ''}`);
          if (r.status !== status || loc !== pub + path) bad('domains', `${method} ${d}${path}: ${r.status} ${loc ?? 'no location'}, want ${status} ${pub + path}`);
        }
      }
    },
    'sign-in': async () => {
      const bridge = async (ret) => {
        const r = await get(`${primary}/sign-in?redirect_url=${encodeURIComponent(ret)}`), body = await r.text();
        return { r, ok: r.status === 200 && /id="sign-in"/.test(body) && /no-store/.test(r.headers.get('cache-control') ?? '') && !!r.headers.get('content-security-policy') };
      };
      const home = signInHref(await json(`${pub}/__sim/worlds.json`), `${pub}/?from=check`);
      if (!home || !home.startsWith(`${primary}/sign-in?`)) bad('sign-in', `the home page's sign-in link is ${home ?? 'missing'}, want ${primary}/sign-in?...`);
      for (const ret of [`${pub}/w/${v2}/?from=check`, `${pub}/?from=check`]) {
        const { r, ok } = await bridge(ret);
        seen.push(`sign-in: ${primary}/sign-in?redirect_url=${ret} -> ${r.status}${ok ? ' bridge' : ''}`);
        if (!ok) { bad('sign-in', `the bridge for a return to ${ret}: ${r.status} ${r.headers.get('location') ?? ''}, want 200 (no-store, its own CSP)`); continue; }
        const back = await done(await page(new URL(ret).pathname + new URL(ret).search));
        seen.push(`sign-in: back at ${ret} -> ${back.status} ${system(back)}`);
        if (back.status !== 200) bad('sign-in', `the page it left (${ret}) answered ${back.status}`);
      }
      const { r } = await bridge('https://elsewhere.example/');
      seen.push(`sign-in: a return elsewhere -> ${r.status}`);
      if (r.status === 200) bad('sign-in', 'the bridge accepted a return to another site');
    },
    headers: async () => {
      for (const path of ['/', `/w/${v2}/`, `/w/${today}/`]) {
        const r = await done(await page(path)), xfo = r.headers.get('x-frame-options') ?? '', csp = r.headers.get('content-security-policy') ?? '';
        seen.push(`headers: ${path} x-frame-options ${xfo || 'none'}; csp ${csp || 'none'}`);
        if (!/^(deny|sameorigin)$/i.test(xfo) && !/frame-ancestors\s+('none'|'self')/.test(csp)) bad('headers', `${path} may be framed by another site`);
        if (/(default|connect|img)-src/.test(csp) && !csp.includes(COUNTER)) bad('headers', `${path}: its CSP blocks the visitor counter (${COUNTER})`);
      }
      for (const path of ['/__sim/healthz', '/v1/worlds', `/w/${today}/v1/config`, `/w/${v2}/v1/config`]) {
        const r = await done(await get(pub + path)), tag = r.headers.get('x-robots-tag') ?? '';
        seen.push(`headers: ${path} -> ${r.status} x-robots-tag ${tag || 'none'}`);
        if (!/noindex/.test(tag)) bad('headers', `${path} may be indexed (no X-Robots-Tag noindex)`);
      }
    },
    robots: async () => {
      const robots = await (await get(`${pub}/robots.txt`)).text();
      if (!/^Sitemap: \S+\/sitemap\.xml$/m.test(robots)) bad('robots', 'robots.txt names no sitemap');
      const r = await get(`${pub}/sitemap.xml`), map = await r.text();
      const listed = new Set([...map.matchAll(/<loc>[^<]*\/w\/([^/<]+)\/<\/loc>/g)].map((m) => m[1]));
      seen.push(`robots: the sitemap (${r.status} ${system(r)}) lists ${listed.size} worlds`);
      if (r.status !== 200 || system(r) !== 'today') bad('robots', `the sitemap answered ${r.status} from ${system(r)}, want 200 from today`);
      if (today && !listed.has(today)) bad('robots', `the sitemap leaves out ${today}`);
      if (unlisted && listed.has(unlisted)) bad('robots', `the sitemap lists the unlisted world ${unlisted}`);
    },
    list: async () => {
      const home = await done(await page('/'));
      seen.push(`list: / -> ${home.status} ${system(home)}`);
      if (home.status !== 200 || system(home) !== 'today') bad('list', `/ answered ${home.status} from ${system(home)}, want today's home (200)`);
      for (const path of ['/v1/worlds', '/v1/auth/config', '/v1/account/session']) {
        const r = await done(await get(pub + path, { headers: { accept: 'application/json' } }));
        seen.push(`list: ${path} -> ${r.status} ${system(r)}`);
        if (system(r) !== 'today' || r.status >= 500) bad('list', `${path} answered ${r.status} from ${system(r)}, want today's launcher`);
      }
    },
    address: async () => {
      const r = await get(`${pub}/__sim/whoami`, { headers: { 'x-forwarded-for': FORGED } }), a = r.ok ? (await r.json()).address : (await r.body?.cancel(), null);
      seen.push(`address: with X-Forwarded-For ${FORGED} the launcher keyed ${a}`);
      if (!a || a === FORGED) bad('address', `the launcher keyed ${a ?? 'nothing'} with a forged X-Forwarded-For`);
    },
    site: async () => {
      const shown = ['cache-control', 'content-type', 'x-robots-tag'];
      for (const [path, accept, want] of [['/changelog', 'text/html', (r, b) => /<html/i.test(b)],
        ['/changelog.md', 'text/markdown', (r, b) => /^#/m.test(b)],
        ['/v1/feed', 'application/json', (r, b) => { try { const d = JSON.parse(b); return Array.isArray(d.items) && 'next' in d; } catch { return false; } }],
        ['/ops', 'text/html', (r) => r.status < 500]]) {
        const r = await get(pub + path, { headers: { accept } }), body = await r.text();
        seen.push(`site: ${path} -> ${r.status} ${system(r)}; ${shown.map((h) => `${h}: ${(r.headers.get(h) ?? 'none').slice(0, 60)}`).join('; ')}`);
        if ((path !== '/ops' && r.status !== 200) || system(r) !== 'today' || !want(r, body)) bad('site', `${path} answered ${r.status} from ${system(r)}, want today's page`);
      }
    },
    stream: async () => {
      const at = stream ?? (v2 ? `/s/${v2}/` : null);
      if (!at) return bad('stream', 'no --stream or --v2 named');
      const r = await done(await get(`${pub}${at}pointer`));
      seen.push(`stream: ${at}pointer -> ${r.status} ${system(r)}`);
      if (r.status !== 200 || system(r) !== 'v2') bad('stream', `${at}pointer answered ${r.status} from ${system(r)}, want 200 from v2`);
    },
    gateway: async () => {
      for (const [slug, want] of [[v2, 'v2'], [today, 'today']]) {
        if (!slug) continue;
        const r = await done(await get(`${pub}/w/${slug}/v2/ws`));
        seen.push(`gateway: /w/${slug}/v2/ws -> ${r.status} ${system(r)}`);
        if (system(r) !== want || r.status === 502) bad('gateway', `/w/${slug}/v2/ws answered ${r.status} from ${system(r)}, want ${want}'s answer`);
      }
    },
    pairing: async () => {
      const card = await get(`${pub}/pair`, { headers: { accept: 'text/html' } }), html = await card.text();
      seen.push(`pairing: /pair -> ${card.status} ${system(card)}`);
      if (card.status !== 200 || system(card) !== 'v2' || !/<html/i.test(html)) bad('pairing', `/pair answered ${card.status} from ${system(card)}, want the new pairing card (200 from v2)`);
      for (const path of ['/v1/pair/poll', '/v1/agent/account']) {
        const r = await done(await get(pub + path, { headers: { accept: 'application/json' } }));
        seen.push(`pairing: ${path} -> ${r.status} ${system(r)}`);
        if (system(r) !== 'v2' || r.status === 502) bad('pairing', `${path} answered ${r.status} from ${system(r)}, want the new system's directory`);
      }
    },
    poster: async () => {
      if (!stopped) return bad('poster', 'name a page behind a stopped origin with --stopped');
      const r = await page(stopped), body = await r.text();
      seen.push(`poster: ${stopped} -> ${r.status} retry-after ${r.headers.get('retry-after') ?? 'none'}`);
      if (r.status !== 503 || !/back in a moment/i.test(body) || !r.headers.get('retry-after')) bad('poster', `${stopped} answered ${r.status}, want 503 "back in a moment" with Retry-After`);
    },
  };
  for (const p of points) { try { await run[p](); } catch (e) { bad(p, e.message); } }
  return { pass: problems.length === 0, problems, seen };
}

if (isMain(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const list = (k) => opt(k)?.split(',').filter(Boolean);
  const pairs = (k) => (list(k) ?? []).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; });
  const r = await frontCheck({ public: opt('--public', 'https://soul.game'), primary: opt('--primary', 'https://sim.eden.art'), old: list('--old') ?? ['https://souls.game'],
    v2: opt('--v2'), today: opt('--today'), aliases: pairs('--alias'), unlisted: opt('--unlisted'), stream: opt('--stream'), stopped: opt('--stopped'),
    points: list('--points') ?? POINTS, map: Object.fromEntries(pairs('--map')) });
  for (const s of r.seen) console.log(`  ${s}`);
  for (const p of r.problems) console.log(`  PROBLEM ${p}`);
  console.log(r.pass ? 'PASS' : 'FAIL');
  process.exitCode = r.pass ? 0 : 1;
}

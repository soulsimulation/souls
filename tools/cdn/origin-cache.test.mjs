import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdnCacheEligible, cdnRuleExpression, originCacheClass, originCacheProblem, STREAM_HOST, streamRuleExpression } from './origin-cache.mjs';
import { checkSoulGame } from '../world-launcher/deploy/caddy/check-soul-game.mjs';
import { EDGE_SNAPSHOT_CACHE } from '../../apps/server/src/edge-snapshot.ts';

const IMM = 'public, max-age=31536000, immutable', DAYSWR = 'public, max-age=86400, stale-while-revalidate=604800';
const r = (path, cc, cf = 'HIT', status = 200) => ({ path, status, headers: { ...(cc ? { 'cache-control': cc } : {}), ...(cf ? { 'cf-cache-status': cf } : {}) } });

test('classes: hashed bundles and parts, release-stable static, everything else ignored', () => {
  assert.equal(originCacheClass('/worlds/assets/LiveWorld-BN26MIPk.js'), 'hashed');
  assert.equal(originCacheClass('/assets/cdn-manifest-BN26MIPk.json'), 'hashed');
  assert.equal(originCacheClass('/worlds/w/eden-2026/v1/world/part/8cd8bf3068833a807af5426e595f3290'), 'hashed');
  assert.equal(originCacheClass('/worlds/mars-assets/draco/draco_decoder.wasm'), 'stable');
  assert.equal(originCacheClass('/worlds/modular/humanoid/kit.json'), 'stable');
  for (const p of ['/worlds/w/eden-2026/', '/worlds/w/eden-2026/v1/world/snapshot?defs=ref', '/v1/site/worlds', '/manifest.webmanifest']) assert.equal(originCacheClass(p), null, p);
});

test('problems: the 3.62 draco miss, a short-lived hashed bundle, an uncacheable part; first-request MISS passes', () => {
  assert.match(originCacheProblem(r('/worlds/mars-assets/draco/draco_wasm_wrapper.js', null, 'DYNAMIC')), /max-age < 1h/);
  assert.match(originCacheProblem(r('/worlds/mars-assets/draco/draco_decoder.wasm', DAYSWR, 'DYNAMIC')), /Cloudflare DYNAMIC/);
  assert.match(originCacheProblem(r('/assets/index-AbCdEf12.js', 'public, max-age=3600')), /immutable/);
  assert.match(originCacheProblem(r('/worlds/w/x/v1/world/part/0123456789abcdef', 'no-store')), /not publicly cacheable/);
  assert.equal(originCacheProblem(r('/worlds/assets/index-AbCdEf12.js', IMM, 'MISS')), null);
  assert.equal(originCacheProblem(r('/worlds/modular/humanoid/kit.json', DAYSWR, 'HIT')), null);
  assert.equal(originCacheProblem(r('/worlds/mars-assets/draco/draco_decoder.wasm', DAYSWR, 'REVALIDATED')), null);
  assert.equal(originCacheProblem(r('/worlds/assets/index-AbCdEf12.js', null, null, 304)), null);
});

const SHA = 'a'.repeat(64), VIEW = 'public, no-cache';
test('mutable GLB views and legacy aliases include root and world-scoped paths', () => {
  for (const prefix of ['', '/worlds', '/w/eden-2026', '/worlds/w/eden-2026']) {
    assert.equal(originCacheClass(`${prefix}/asset-view/${SHA}.glb`), 'mutable-view');
    assert.equal(originCacheClass(`${prefix}/asset-view/${SHA}.glb?cache=unchanged`), 'mutable-view');
    assert.equal(originCacheClass(`${prefix}/assets/${SHA}.glb`), 'legacy-glb');
    assert.equal(originCacheClass(`${prefix}/assets/${SHA}.png`), 'hashed');
    assert.equal(originCacheClass(`${prefix}/asset-view/${SHA}.png`), null);
  }
});
test('mutable views require public no-cache without immutable and allow dynamic origin validation', () => {
  const path = `/worlds/w/eden-2026/asset-view/${SHA}.glb`;
  for (const cf of ['DYNAMIC', 'BYPASS', 'HIT', 'MISS', 'REVALIDATED']) assert.equal(originCacheProblem(r(path, VIEW, cf)), null);
  for (const cc of [null, IMM, 'no-cache', 'public, max-age=0', 'public, no-cache, immutable', 'public, no-cache="ETag"']) assert.match(originCacheProblem(r(path, cc)), /mutable asset view/, cc);
  for (const cc of ['private, no-cache', 'no-store']) assert.match(originCacheProblem(r(path, cc)), /not publicly cacheable/);
  assert.match(originCacheProblem(r(path, IMM, 'BYPASS')), /mutable asset view/);
});
test('legacy core GLBs may revalidate while uploaded GLBs and other hash objects retain immutable checks', () => {
  const glb = `/worlds/w/eden-2026/assets/${SHA}.glb`, png = glb.replace('.glb', '.png');
  assert.equal(originCacheProblem(r(glb, VIEW, 'DYNAMIC')), null);
  assert.equal(originCacheProblem(r(glb, VIEW, 'BYPASS')), null);
  assert.equal(originCacheProblem(r(glb, IMM, 'HIT')), null);
  assert.match(originCacheProblem(r(glb, IMM, 'DYNAMIC')), /Cloudflare DYNAMIC/);
  assert.match(originCacheProblem(r(glb, IMM, 'BYPASS')), /Cloudflare BYPASS/);
  assert.match(originCacheProblem(r(glb, 'public, max-age=3600')), /immutable/);
  assert.match(originCacheProblem(r(glb, 'no-cache')), /mutable asset view/);
  assert.match(originCacheProblem(r(glb, 'public, no-cache, immutable')), /mutable asset view/);
  assert.match(originCacheProblem(r(png, VIEW, 'DYNAMIC')), /immutable/);
  assert.equal(originCacheProblem(r(png, IMM, 'HIT')), null);
});

// --- E2: the CDN cache rule ------------------------------------------------------------------------------------------
// One sample path per hashed and stable class, in soul.game's root-launcher form, with the policy the origin sends it.
const RULE_SAMPLES = [
  ['/assets/LiveWorld-BN26MIPk.js', IMM],                                    // Vite bundle
  [`/assets/${SHA}.png`, IMM], [`/w/eden/assets/${SHA}.png`, IMM],           // content-addressed stored objects
  ['/w/eden/v1/world/part/8cd8bf3068833a807af5426e595f3290', IMM],           // snapshot part
  [`/w/eden/art/${SHA}.png`, IMM],                                           // hung art
  ['/w/eden/v1/souls/s_1/profile-photo/0123456789abcdef', IMM],              // profile photo
  ['/modular/humanoid/kit.json', DAYSWR], ['/mars-assets/draco/draco_decoder.wasm', DAYSWR], ['/world-assets/eden/sky.json', DAYSWR],
  ['/w/eden/fonts/inter.woff2', DAYSWR],
];
test('E2 A1: every hashed and stable class is eligible under the documented rule; HIT/MISS accepted, DYNAMIC/BYPASS refused', () => {
  const seen = new Set();
  for (const [path, cc] of RULE_SAMPLES) {
    const cls = originCacheClass(path); assert.ok(cls === 'hashed' || cls === 'stable', `${path}: ${cls}`); seen.add(cls);
    assert.equal(cdnCacheEligible(path), true, `${path} is not eligible under the rule`);
    for (const cf of ['HIT', 'MISS', 'EXPIRED', 'REVALIDATED']) assert.equal(originCacheProblem(r(path, cc, cf)), null, `${path} ${cf}`);
    for (const cf of ['DYNAMIC', 'BYPASS']) assert.match(originCacheProblem(r(path, cc, cf)), new RegExp(`Cloudflare ${cf}`), `${path} ${cf}`);
  }
  assert.deepEqual([...seen].sort(), ['hashed', 'stable']);
  assert.equal(cdnCacheEligible('/w/eden/v1/world/snapshot?defs=ref&cols=1&v=12.3.4'), true, 'the snapshot (the origin keeps it no-store unless keyed)');
  // nothing that can answer per user, nor the page and the lists (E3's)
  for (const p of ['/', '/w/eden/', '/w/eden', '/v1/config', '/w/eden/v1/config', '/v1/site/worlds', '/__sim/healthz', '/__sim/thumbs/eden.webp', '/w/eden/ws', '/w/eden/v1/edge/act',
    '/w/eden/v1/edge/events', `/w/eden/v1/god/assets/${SHA}`, '/w/eden/v1/god/fonts/x.woff2', '/w/eden/v1/art/media', '/v1/me', `/w/eden/asset-view/${SHA}.glb`]) assert.equal(cdnCacheEligible(p), false, p);
});
test('E2 A3: docs/operations/cdn.md gives the rule expression verbatim', () => {
  const doc = readFileSync(new URL('../../docs/operations/cdn.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(cdnRuleExpression()), 'cdn.md does not carry cdnRuleExpression(): paste the current one');
});

const listen = (s) => new Promise((yes) => s.listen(0, '127.0.0.1', () => yes({ url: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeAllConnections(); s.close(); } })));
/** A stand-in CDN: keeps a GET only on a path `eligible` allows, for the origin's s-maxage or max-age (none, no-store,
 *  private or 0: not kept, BYPASS); anything else passes through as DYNAMIC. Cloudflare's cf-cache-status words. */
function standInCdn(origin, eligible, upstreamPath = (u) => u) {
  const kept = new Map();
  return listen(createServer(async (req, res) => {
    const send = (st, h, body, cf, extra = {}) => res.writeHead(st, { ...h, 'cf-cache-status': cf, ...extra }).end(body);
    const hit = kept.get(req.url);
    if (eligible(req.url) && hit && hit.until > Date.now()) return send(hit.status, hit.headers, hit.body, 'HIT', { age: String(Math.floor((Date.now() - hit.at) / 1000)) });
    const o = await fetch(origin + upstreamPath(req.url), { headers: { accept: req.headers.accept ?? '*/*' } }), body = Buffer.from(await o.arrayBuffer());
    const cc = o.headers.get('cache-control') ?? '', headers = { 'content-type': o.headers.get('content-type') ?? '', ...(cc ? { 'cache-control': cc } : {}) };
    if (!eligible(req.url)) return send(o.status, headers, body, 'DYNAMIC');
    const ttl = Number((/s-maxage=(\d+)/.exec(cc) ?? /max-age=(\d+)/.exec(cc) ?? [0, 0])[1]);
    if (o.status !== 200 || !cc || /no-store|private/.test(cc) || ttl <= 0) return send(o.status, headers, body, 'BYPASS');
    kept.set(req.url, { status: o.status, headers, body, at: Date.now(), until: Date.now() + ttl * 1000 });
    send(o.status, headers, body, 'MISS');
  }));
}
/** The origin as the launcher answers these paths: the page (never cached) with the snapshot key and parts, the bundle,
 *  a part, a stable file, and the snapshot (cacheable only under the current key, as edge-snapshot.ts does). */
function standInOrigin({ staleCacheable = false } = {}) {
  const KEY = '41.2.7', PART = 'ab'.repeat(16);
  return listen(createServer((req, res) => {
    const [path, q = ''] = req.url.split('?'), v = new URLSearchParams(q).get('v');
    const ok = (type, cc, body) => res.writeHead(200, { 'content-type': type, 'cache-control': cc }).end(body);
    if (path === '/w/eden/') return ok('text/html', 'no-cache', `<!doctype html><head><script>window.__simSnapshotKey="${KEY}";window.__simSnapshotParts=["${PART}","${'cd'.repeat(16)}"]</script><script type="module" crossorigin src="/assets/index-AbCd1234.js"></script></head>`);
    if (path === '/assets/index-AbCd1234.js') return ok('text/javascript', IMM, 'export {}');
    if (path === `/w/eden/v1/world/part/${PART}`) return ok('application/json', IMM, '{}');
    if (path === '/mars-assets/draco/draco_decoder.wasm') return ok('application/wasm', 'public, max-age=86400', 'wasm');
    if (path === '/w/eden/v1/world/snapshot') return ok('application/json', v === KEY || staleCacheable ? EDGE_SNAPSHOT_CACHE : 'no-store', '{"tick":1}');
    res.writeHead(404).end();
  }));
}
const cacheCheck = async (eligible, opts) => {
  const o = await standInOrigin(opts), cdn = await standInCdn(o.url, eligible);
  try { return await checkSoulGame({ origin: cdn.url, points: ['cache'], waitMs: 3000 }); } finally { cdn.close(); o.close(); }
};
test('E2 A2: the check\'s cache section passes through a stand-in CDN configured from the documented rule', async (t) => {
  const r = await cacheCheck(cdnCacheEligible);
  t.diagnostic(`check-soul-game --points cache:\n${r.seen.map((x) => `  ${x}`).join('\n')}\n${r.pass ? 'PASS' : 'FAIL'}`);
  assert.equal(r.pass, true, r.problems.join('\n'));
  assert.equal(r.seen.length, 5, r.seen.join('\n'));
});
test('E2 A2: the same check fails without the rule (the CDN\'s by-extension default) and when a stale key is kept', async () => {
  const byExtension = (u) => /\.(?:js|css|png|jpg|wasm|woff2?)$/.test(u.split('?')[0]);
  const d = await cacheCheck(byExtension);
  assert.deepEqual(d.problems.map((p) => /^cache: (\w+)/.exec(p)?.[1]), ['part', 'snapshot'], d.problems.join('\n'));
  const s = await cacheCheck(cdnCacheEligible, { staleCacheable: true });
  assert.equal(s.problems.length, 1, s.problems.join('\n')); assert.match(s.problems[0], /stale key answered HIT/);
});

// --- #4159: a world's public stream (/s/*) behind the CDN -------------------------------------------------------------
test('#4159 A1: every kind of stream file is eligible under the documented rule', () => {
  const g = 'ab'.repeat(32);
  for (const p of ['/s/eden/pointer', `/s/eden/g/${g}/baseline`, `/s/eden/g/${g}/baseline.text`, `/s/eden/g/${g}/12`, `/s/eden/g/${g}/12.text`,
    '/s/eden/7', `/s/headers/${'cd'.repeat(32)}`, '/s/w/0123abcd/views/public/pointer', '/s/h/garden/garden/bundles/00000002/index',
    '/s/w/0123abcd/history/live']) assert.equal(cdnCacheEligible(p), true, p);
  for (const p of ['/s/v1/feed', '/s/w/eden/v1/bootstrap']) assert.equal(cdnCacheEligible(p), false, p);
});
test('#4159 A2: through a stand-in CDN from the rule and the real viewers\' origin: files kept, the pointer 1 s, misses never', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-4159-')), g = 'ab'.repeat(32), at = (...p) => join(dir, 'eden', ...p);
  mkdirSync(at('g', g), { recursive: true });
  writeFileSync(at('pointer'), 'p1'); writeFileSync(at('g', g, 'baseline'), 'base'); writeFileSync(at('g', g, '0'), 'part0');
  // The viewers' origin as production runs it (v2/tools/origin/origin.mjs), started as its own program (K14: nothing
  // outside v2/ imports from it).
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../v2/tools/origin/origin.mjs', import.meta.url)), dir, '0', '127.0.0.1'], { env: { ...process.env, ORIGIN_PROCESSES: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok, no) => { let out = ''; child.stdout.on('data', (d) => { out += d; const m = /origin (\d+)\n/.exec(out); if (m) ok(m[1]); }); child.on('exit', (c) => no(new Error(`origin ended (${c})`))); });
  const origin = { url: `http://127.0.0.1:${port}`, close: () => child.kill('SIGKILL') };
  // Caddy's `handle_path /s/*` hands the origin the path without /s.
  const cdn = await standInCdn(origin.url, cdnCacheEligible, (u) => u.replace(/^\/s\//, '/'));
  const get = async (p) => { const r = await fetch(cdn.url + p); return { status: r.status, cf: r.headers.get('cf-cache-status'), cc: r.headers.get('cache-control'), cookie: r.headers.get('set-cookie'), body: await r.text() }; };
  try {
    for (const p of [`/s/eden/g/${g}/baseline`, `/s/eden/g/${g}/0`]) {
      const a = await get(p), b = await get(p);
      assert.deepEqual([a.status, a.cf, b.cf], [200, 'MISS', 'HIT'], p); assert.match(a.cc, /immutable/); assert.equal(a.cookie, null);
    }
    const p1 = await get('/s/eden/pointer'), p2 = await get('/s/eden/pointer');
    assert.deepEqual([p1.cf, p2.cf, p2.body], ['MISS', 'HIT', 'p1']); assert.equal(p1.cc, 'public, max-age=1, no-transform'); assert.equal(p1.cookie, null);
    writeFileSync(at('pointer'), 'p2');
    await new Promise((r) => setTimeout(r, 1100));
    const p3 = await get('/s/eden/pointer');
    assert.deepEqual([p3.cf, p3.body], ['MISS', 'p2'], 'the pointer is kept at most a second');
    const early = await get(`/s/eden/g/${g}/1`), again = await get(`/s/eden/g/${g}/1`);
    assert.deepEqual([early.status, early.cf, early.cc, again.cf], [404, 'BYPASS', 'no-store', 'BYPASS'], 'a part asked early is never kept');
    writeFileSync(at('g', g, '1'), 'part1');
    const now = await get(`/s/eden/g/${g}/1`);
    assert.deepEqual([now.status, now.body], [200, 'part1'], 'once written it is served');
    const q = await get('/s/eden/pointer?x=1'), q2 = await get('/s/eden/pointer?x=1');
    assert.deepEqual([q.status, q.cf, q2.cf], [404, 'BYPASS', 'BYPASS'], 'a query string is a no-store 404, never kept');
  } finally { cdn.close(); origin.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('#4159: the stream hostname is one name everywhere: the rule in cdn.md, the page\'s STREAM_ORIGIN, the Caddy site', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8'), host = STREAM_HOST.replaceAll('.', '\\.');
  assert.equal(streamRuleExpression(), '(http.host eq "stream.eden.art")');
  assert.ok(read('../../docs/operations/cdn.md').includes('\n' + streamRuleExpression() + '\n'), 'cdn.md does not carry streamRuleExpression()');
  assert.match(read('../../v2/web/src/source/address.ts'), new RegExp(`STREAM_ORIGIN = 'https://${host}'`));
  assert.match(read('../../v2/tools/ops/proxy/stream-eden-art.caddy'), new RegExp(`^https://${host} \\{$`, 'm'));
});

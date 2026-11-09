#!/usr/bin/env node
// Checks the former origin's redirect from outside (#1416; the site file is sim-eden-art.caddy beside this script):
//   node tools/world-launcher/deploy/caddy/check-sim-redirect.mjs [--origin https://sim.eden.art] [--canonical https://soul.game]
// Every sampled path answers a permanent redirect to <canonical><the same path and query>: 301 for GET and HEAD, 308 for
// a POST. /sign-in with a valid return answers 200 with the Clerk primary bridge (no-store, its own CSP), never a
// redirect. The canonical site serves the redirected world pages. Prints PASS or FAIL with each problem; exit 0 on PASS.
// Read-only: GET and HEAD, plus one POST to an unknown path that is redirected before anything reads it.
import { fileURLToPath } from 'node:url';

export const SAMPLES = ['/', '/w/eden/', '/w/mars-college-2026/?view=map', '/worlds/', '/worlds/w/eden-2026/', '/changelog', '/__sim/healthz', '/blobs/assets/00/x.glb'];
export const PAGES = ['/w/eden/', '/'];

export async function checkRedirect({ origin = 'https://sim.eden.art', canonical = 'https://soul.game', fetchImpl = fetch } = {}) {
  const problems = [], seen = [];
  const get = (url, init = {}) => fetchImpl(url, { redirect: 'manual', ...init, headers: { 'user-agent': 'souls-check-sim-redirect', ...(init.headers ?? {}) } });
  const expectRedirect = async (path, method, status) => {
    let r; try { r = await get(origin + path, { method }); } catch (e) { problems.push(`${method} ${path}: ${e.message}`); return; }
    const loc = r.headers.get('location'), want = canonical + path;
    seen.push(`${method} ${path} -> ${r.status} ${loc ?? ''}`);
    if (r.status !== status) problems.push(`${method} ${path}: ${r.status}, want ${status}`);
    if (loc !== want) problems.push(`${method} ${path}: location ${loc ?? 'none'}, want ${want}`);
  };
  for (const p of SAMPLES) await expectRedirect(p, 'GET', 301);
  await expectRedirect('/w/eden/', 'HEAD', 301);
  await expectRedirect('/worlds/w/eden/v1/check-sim-redirect', 'POST', 308);
  // the Clerk primary bridge stays on this origin, query intact
  const ret = encodeURIComponent(`${canonical}/w/eden/`);
  try {
    const r = await get(`${origin}/sign-in?redirect_url=${ret}`), body = await r.text();
    seen.push(`GET /sign-in?redirect_url=... -> ${r.status}`);
    if (r.status !== 200) problems.push(`/sign-in: ${r.status}${r.headers.get('location') ? ` to ${r.headers.get('location')}` : ''}, want 200 (the Clerk primary bridge)`);
    else {
      if (!/id="sign-in"/.test(body) || !/clerk/i.test(body)) problems.push('/sign-in: not the Clerk sign-in bridge');
      if (!/no-store/.test(r.headers.get('cache-control') ?? '')) problems.push('/sign-in: not no-store');
      if (!r.headers.get('content-security-policy')) problems.push('/sign-in: no content-security-policy');
    }
  } catch (e) { problems.push(`/sign-in: ${e.message}`); }
  // the redirect lands somewhere that answers
  for (const p of PAGES) {
    try { const r = await fetchImpl(canonical + p, { headers: { 'user-agent': 'souls-check-sim-redirect' } }); seen.push(`canonical ${p} -> ${r.status}`); if (!r.ok) problems.push(`canonical ${p}: ${r.status}`); await r.arrayBuffer(); }
    catch (e) { problems.push(`canonical ${p}: ${e.message}`); }
  }
  return { pass: problems.length === 0, problems, seen };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const r = await checkRedirect({ origin: opt('--origin', 'https://sim.eden.art').replace(/\/$/, ''), canonical: opt('--canonical', 'https://soul.game').replace(/\/$/, '') });
  for (const s of r.seen) console.log(`  ${s}`);
  for (const p of r.problems) console.log(`  PROBLEM ${p}`);
  console.log(r.pass ? 'PASS' : 'FAIL');
  process.exitCode = r.pass ? 0 : 1;
}

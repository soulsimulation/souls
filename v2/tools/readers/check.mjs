// The check through a cache or CDN (Engine v2 V2, #2711): the headers a reader sees on a part, the pointer and a 404,
// and the early-ask case. Part N+1 is asked before the pointer names it (it must be a 404 that is not kept), then
// again once the pointer names it, through the same address: it must arrive, whole (its SHA-256 equal to its ETag).
// A cache that kept the 404 (Fact 3: three minutes on Cloudflare by default) fails here.
// Usage: node check.mjs <base URL> <stream path>. Prints one `check {json}` line; exits 1 when a check fails.
import { isMain } from '../../../tools/lib/is-main.mjs';
import { agentFor, get, readPointer, sha256 } from './readers.mjs';

export async function check(base, stream) {
  const agent = agentFor(base);
  const dir = `/${stream.replace(/^\/|\/$/g, '')}/`;
  const at = (path) => get(base, dir + path, agent);
  const cc = (r) => r.headers['cache-control'] ?? '';
  const out = { failures: [] };
  const expect = (ok, what) => ok || out.failures.push(what);

  let ptr;
  for (let i = 0; i < 40; i++) {
    const p = await at('pointer');
    expect(p.status === 200, `pointer ${p.status}`);
    ptr = readPointer(p.body);
    out.pointer = { status: p.status, cacheControl: cc(p) };
    if (ptr.newest !== undefined) break;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  expect(/max-age=1\b/.test(out.pointer.cacheControl) && !/immutable/.test(out.pointer.cacheControl), 'pointer cache-control');

  const n = ptr.newest;
  const part = await at(String(n));
  out.part = { number: n, status: part.status, cacheControl: cc(part), etag: part.headers.etag ?? null };
  expect(part.status === 200, `part ${n} ${part.status}`);
  expect(/immutable/.test(cc(part)) && /max-age=31536000/.test(cc(part)) && /no-transform/.test(cc(part)), 'part cache-control');
  expect(part.headers.etag?.replaceAll('"', '') === sha256(part.body), 'part checksum');

  const early = await at(String(n + 1));
  out.early = { number: n + 1, status: early.status, cacheControl: cc(early) };
  expect(early.status === 404, `early ${early.status}`);
  expect(cc(early) === 'no-store', 'early cache-control');

  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    await new Promise((ok) => setTimeout(ok, 250));
    if ((readPointer((await at('pointer')).body).newest ?? -1) > n) break;
  }
  const late = await at(String(n + 1));
  out.onTime = { number: n + 1, status: late.status, afterMs: Date.now() - t0, checksum: late.headers.etag?.replaceAll('"', '') === sha256(late.body) };
  expect(late.status === 200, `on time ${late.status}`);
  expect(out.onTime.checksum, 'on-time checksum');
  agent.destroy();
  out.pass = out.failures.length === 0;
  return out;
}

if (isMain(import.meta.url)) {
  const [base, stream] = process.argv.slice(2);
  if (!stream) throw new Error('usage: node check.mjs <base URL> <stream path>');
  const r = await check(base, stream);
  console.log(`check ${JSON.stringify(r)}`);
  process.exit(r.pass ? 0 : 1);
}

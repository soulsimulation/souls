#!/usr/bin/env node
// #4986: copies a world page's immutable first-load files from the origin to the asset CDN, so a new viewer downloads
// them from an edge and not from the host. Today that is the new engine's replica: `replica.js` and the `replica_bg.wasm`
// it loads beside itself, which the launcher serves by version (tools/world-launcher/cutover.mjs) and the page names in
// its inline config (`v2Replica`). Run it after a release that changed the replica; the launcher looks on the CDN once
// a minute and tells the page of the copy when both files answer there (`v2ReplicaCdn`), so nothing waits on this.
//
//   node tools/cdn/mirror-first-load.mjs https://soul.game/w/eden/                       # dry run: reads the origin, prints the plan
//   EDEN_ASSETS_CREDENTIALS=<file> node tools/cdn/mirror-first-load.mjs https://soul.game/w/eden/ --apply [--out <new receipt.json>]
//   node tools/cdn/mirror-first-load.mjs https://soul.game/w/eden/ --check               # no credentials: the CDN's copy as a browser gets it
//
// What it may read and write is fixed here, never taken from the page: from the origin, the page itself and the two
// versioned replica files; on the CDN, `assets/replica/<version>/replica.js` and `…/replica_bg.wasm`. The version is the
// first 16 hex of sha256 over both files (the launcher's rule), checked before anything is stored, so a key always holds
// the bytes its name says. Objects are written once (`If-None-Match: *`), stored as quality-11 brotli with
// `Content-Encoding: br` and `Cache-Control: public, max-age=31536000, immutable`, read back and hashed; an existing
// object must carry the same hash or the run stops. No API, sign-in or per-user answer has a key here.
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { isMain } from '../lib/is-main.mjs';
import { CACHE } from './inventory.mjs';
import { BUCKET, ENDPOINT, loadCredentials, requireAccount, sigv4Headers } from './publish.mjs';

export const CDN = 'https://cdn.soul.game';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CONFIG = /<script>window\.__simConfig=(\{.*?\})<\/script>/s;
const NAMED = /^\/w\/[a-z0-9][a-z0-9-]{0,62}\/v2\/replica\/([0-9a-f]{16})\/replica\.js$/;
const KEY = /^assets\/replica\/[0-9a-f]{16}\/(?:replica\.js|replica_bg\.wasm)$/;
const TYPES = { 'replica.js': 'text/javascript; charset=utf-8', 'replica_bg.wasm': 'application/wasm' };

/** The versioned replica path a page's HTML names (`v2Replica` in its inline config), or a thrown reason. */
export function namedReplica(html) {
  let config; try { config = JSON.parse(CONFIG.exec(html)?.[1] ?? 'null'); } catch { config = null; }
  const m = typeof config?.v2Replica === 'string' ? NAMED.exec(config.v2Replica) : null;
  if (!m) throw Error('the page names no versioned replica (v2Replica): not a world the new engine runs, or an older launcher');
  return { path: config.v2Replica, version: m[1] };
}

/** Reads the page and its two replica files from the origin and returns the objects to store. Throws unless both are
 *  the launcher's current, immutable answers and hash to the version in their path. */
export async function plan(page, { fetcher = fetch } = {}) {
  const url = new URL(page);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw Error('the page must be an https address');
  const get = async (u) => { const r = await fetcher(u, { redirect: 'error', signal: AbortSignal.timeout(60_000) }); if (r.status !== 200) throw Error(`${r.status} for ${u}`); return r; };
  const { path, version } = namedReplica(await (await get(url.href)).text());
  const objects = [];
  for (const name of Object.keys(TYPES)) {
    const from = new URL(path.replace(/replica\.js$/, name), url).href, r = await get(from);
    if (!/\bimmutable\b/.test(r.headers.get('cache-control') ?? '')) throw Error(`${from} is not the launcher's current version (no immutable answer)`);
    const body = Buffer.from(await r.arrayBuffer());
    objects.push({ key: `assets/replica/${version}/${name}`, from, contentType: TYPES[name], bytes: body.length, sha256: sha(body), body });
  }
  const got = createHash('sha256').update(objects[0].body).update(objects[1].body).digest('hex').slice(0, 16);
  if (got !== version) throw Error(`the origin's replica hashes to ${got}, not the ${version} its path names`);
  for (const o of objects) {
    o.encoded = brotliCompressSync(o.body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: o.body.length } });
    o.encodedBytes = o.encoded.length; o.encodedSha256 = sha(o.encoded);
  }
  return { version, page: url.href, objects };
}

const publicRow = ({ body, encoded, ...o }) => o;

/** Stores the plan's objects (write once, verify, read back). `credentials` as publish.mjs loads them. */
export async function store(planned, { credentials, fetcher = fetch, now } = {}) {
  const results = [];
  for (const o of planned.objects) {
    if (!KEY.test(o.key) || !o.key.startsWith(`assets/replica/${planned.version}/`)) throw Error(`not a replica key: ${o.key}`);
    const url = new URL(`/${BUCKET}/${o.key}`, ENDPOINT);
    const request = (method, body, headers = {}, unsigned = {}) => fetcher(url.href, { method, headers: { ...sigv4Headers({ url, method, credentials, body: body ?? Buffer.alloc(0), headers, now }), ...unsigned }, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(180_000) });
    const same = (r) => r.headers.get('x-amz-meta-sha256') === o.sha256 && r.headers.get('content-encoding') === 'br' && r.headers.get('content-type') === o.contentType && r.headers.get('cache-control') === CACHE;
    let disposition = 'existing';
    const head = await request('HEAD');
    if (head.status === 404) {
      const put = await request('PUT', o.encoded, { 'if-none-match': '*', 'content-type': o.contentType, 'cache-control': CACHE, 'content-encoding': 'br', 'x-amz-meta-sha256': o.sha256, 'x-amz-meta-encoded-sha256': o.encodedSha256 });
      await put.body?.cancel();
      if (put.status === 412) { const raced = await request('HEAD'); if (raced.status !== 200 || !same(raced)) throw Error(`immutable key conflict after a racing PUT: ${o.key}`); }
      else if (!put.ok) throw Error(`PUT failed (${put.status}) for ${o.key}`);
      else disposition = 'uploaded';
    } else if (head.status !== 200) throw Error(`HEAD failed (${head.status}) for ${o.key}`);
    else if (!same(head)) throw Error(`refusing to overwrite ${o.key}: it holds other bytes or headers`);
    const back = await request('GET', undefined, {}, { 'accept-encoding': 'br' });   // fetch decodes: the body is the file itself
    if (back.status !== 200 || !same(back) || sha(Buffer.from(await back.arrayBuffer())) !== o.sha256) throw Error(`readback differs for ${o.key}`);
    results.push({ ...publicRow(o), disposition, verified: true });
  }
  return { version: 1, at: new Date().toISOString(), bucket: BUCKET, replica: planned.version, ok: true, results };
}

/** The CDN's copy as a browser on the page's origin gets it: 200, the module and WASM types, immutable, readable from
 *  that origin, and the bytes the origin serves. No credentials. → rows with `problems` (empty when fine). */
export async function check(planned, { cdn = CDN, fetcher = fetch } = {}) {
  const origin = new URL(planned.page).origin, rows = [];
  for (const o of planned.objects) {
    const url = `${cdn}/${o.key}`, r = await fetcher(url, { headers: { origin, 'accept-encoding': 'br' }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    const h = r.headers, body = r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null, problems = [];
    if (r.status !== 200) problems.push(`status ${r.status}`);
    else {
      if (sha(body) !== o.sha256) problems.push('bytes differ from the origin');
      if (h.get('content-type') !== o.contentType) problems.push(`content-type ${h.get('content-type')}`);
      if (h.get('cache-control') !== CACHE) problems.push(`cache-control ${h.get('cache-control')}`);
      if (![origin, '*'].includes(h.get('access-control-allow-origin'))) problems.push(`not readable from ${origin} (access-control-allow-origin ${h.get('access-control-allow-origin')})`);
    }
    rows.push({ url, status: r.status, cf: h.get('cf-cache-status'), problems });
  }
  return rows;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
  const o = argv.indexOf('--out'), out = o < 0 ? null : argv.splice(o, 2)[1];
  const apply = flag('--apply'), only = flag('--check'), [page] = argv;
  if (!page || argv.length !== 1) { console.error('usage: mirror-first-load.mjs <world page url> [--apply [--out <new receipt.json>]] [--check]'); process.exit(2); }
  const planned = await plan(page);
  console.log(JSON.stringify({ replica: planned.version, objects: planned.objects.map(publicRow) }, null, 1));
  if (apply) {
    requireAccount();
    const receipt = await store(planned, { credentials: await loadCredentials() });
    if (out) writeFileSync(out, JSON.stringify(receipt, null, 1) + '\n', { flag: 'wx' });
    console.log(receipt.results.map((r) => `${r.disposition} ${r.key}`).join('\n'));
  }
  if (apply || only) {
    const rows = await check(planned);
    console.log(JSON.stringify(rows, null, 1));
    if (rows.some((r) => r.problems.length)) process.exit(1);
  } else console.log('dry run: nothing stored. --apply stores these objects; --check reads the CDN\'s copy.');
}

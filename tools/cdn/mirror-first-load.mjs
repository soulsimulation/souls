#!/usr/bin/env node
// #4986: copies a world page's immutable first-load files from the origin to the asset CDN, so a new viewer downloads
// them from an edge and not from the host. Two sets, each read from the live origin, so the copy is of the bytes it serves:
// - the new engine's replica: `replica.js` and the `replica_bg.wasm` it loads beside itself, which the launcher serves by
//   version (tools/world-launcher/cutover.mjs) and the page names in its inline config (`v2Replica`);
// - the web build's own files: everything in its `assets/` folder (scripts, styles, data, images, sounds), which the
//   launcher lists at `/__sim/app-files.json` with their hashes and a set id (tools/world-launcher/app-files.mjs).
// Run it after each release. The launcher looks on the CDN once a minute and tells the page of a copy when it is there
// (`v2ReplicaCdn`; `appCdn`), so nothing waits on this: until then the page loads the origin's files, as before.
//
//   node tools/cdn/mirror-first-load.mjs https://soul.game/w/eden/                       # dry run: reads the origin, prints the plan
//   EDEN_ASSETS_CREDENTIALS=<file> node tools/cdn/mirror-first-load.mjs https://soul.game/w/eden/ --apply [--out <new receipt.json>]
//   node tools/cdn/mirror-first-load.mjs https://soul.game/w/eden/ --check               # no credentials: the CDN's copies as a browser gets them
//
// What it may read and write is fixed here, never taken from the page. From the origin: the page, its two versioned
// replica files, the file list and the listed files under `assets/`. On the CDN: `assets/replica/<version>/replica.js`
// and `…/replica_bg.wasm`; `assets/app/<name>` for a listed build file; and `assets/app/sets/<set>.json`, the set's
// marker, written last, once every file of the set is stored and read back. Every file is hashed against what names it
// before anything is stored (the replica's version is the first 16 hex of sha256 over both files, the launcher's rule; a
// build file's sha256 is in the list, and the set id is the hash of the list), so a key always holds the bytes its name
// says. Objects are written once (`If-None-Match: *`) with `Cache-Control: public, max-age=31536000, immutable`, text and
// WASM as quality-11 brotli with `Content-Encoding: br`, then read back and hashed; an existing object must carry the same
// hash or the run stops, and the marker is then not written. No API, sign-in or per-user answer has a key here.
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { isMain } from '../lib/is-main.mjs';
import { CACHE } from './inventory.mjs';
import { BUCKET, ENDPOINT, loadCredentials, requireAccount, sigv4Headers } from './publish.mjs';
import { APP_FILE, APP_FILES, setOf } from '../world-launcher/app-files.mjs';

export const CDN = 'https://cdn.soul.game';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CONFIG = /<script>window\.__simConfig=(\{.*?\})<\/script>/s;
const NAMED = /^\/w\/[a-z0-9][a-z0-9-]{0,62}\/v2\/replica\/([0-9a-f]{16})\/replica\.js$/;
const REPLICA_KEY = /^assets\/replica\/[0-9a-f]{16}\/(?:replica\.js|replica_bg\.wasm)$/, SET_KEY = /^assets\/app\/sets\/[0-9a-f]{32}\.json$/;
/** The only keys this tool writes. */
export const allowedKey = (key) => REPLICA_KEY.test(key) || SET_KEY.test(key) || (key.startsWith('assets/app/') && APP_FILE.test(key.slice('assets/app/'.length)));
const TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', mp3: 'audio/mpeg', mp4: 'video/mp4', woff2: 'font/woff2' };
const BR = new Set(['js', 'css', 'json', 'wasm', 'svg']);
const typeOf = (name) => TYPES[name.split('.').pop()];
const get = async (fetcher, u) => { const r = await fetcher(u, { redirect: 'error', signal: AbortSignal.timeout(60_000) }); if (r.status !== 200) throw Error(`${r.status} for ${u}`); return r; };
const immutable = (r, u) => { if (!/\bimmutable\b/.test(r.headers.get('cache-control') ?? '')) throw Error(`${u} is not an immutable answer of the origin`); };
/** An object to store: the file, its hash, and its stored form (brotli for text and WASM). */
function object(key, from, body) {
  const ext = key.split('.').pop(), o = { key, from, contentType: typeOf(key), bytes: body.length, sha256: sha(body), body };
  if (BR.has(ext)) { o.encoding = 'br'; o.stored = brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } }); o.storedBytes = o.stored.length; }
  else o.stored = body;
  return o;
}
const pageUrl = (page) => { const url = new URL(page); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw Error('the page must be an https address'); return url; };

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
  const url = pageUrl(page);
  const { path, version } = namedReplica(await (await get(fetcher, url.href)).text());
  const objects = [];
  for (const name of ['replica.js', 'replica_bg.wasm']) {
    const from = new URL(path.replace(/replica\.js$/, name), url).href, r = await get(fetcher, from);
    immutable(r, from);
    objects.push(object(`assets/replica/${version}/${name}`, from, Buffer.from(await r.arrayBuffer())));
  }
  const got = createHash('sha256').update(objects[0].body).update(objects[1].body).digest('hex').slice(0, 16);
  if (got !== version) throw Error(`the origin's replica hashes to ${got}, not the ${version} its path names`);
  return { version, page: url.href, objects };
}

/** Reads the launcher's file list and every listed file from the origin. → `{ set, page, objects }`, the marker last; or
 *  null when the origin has no list (an older launcher, or a build that cannot be copied whole). Throws when a file
 *  is not what the list says. */
export async function planApp(page, { fetcher = fetch } = {}) {
  const url = pageUrl(page), root = new URL(url.pathname.replace(/w\/[^/]+\/?$/, ''), url);
  const listed = await fetcher(new URL('__sim/app-files.json', root).href, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (listed.status === 404) return null;
  if (listed.status !== 200) throw Error(`${listed.status} for the file list`);
  const list = await listed.json();
  if (list?.schema !== APP_FILES || !Array.isArray(list.files) || !list.files.length || list.files.length > 2000) throw Error('the origin\'s file list is not one this tool reads');
  const files = list.files.map((f) => ({ name: f?.name, bytes: f?.bytes, sha256: f?.sha256 }));
  for (const f of files) if (typeof f.name !== 'string' || !APP_FILE.test(f.name) || !Number.isSafeInteger(f.bytes) || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) throw Error(`not a build file: ${String(f.name).slice(0, 80)}`);
  if (new Set(files.map((f) => f.name)).size !== files.length || setOf(files) !== list.set) throw Error('the file list does not hash to its set id');
  const objects = [];
  for (const f of files) {
    const from = new URL(`assets/${f.name}`, root).href, r = await get(fetcher, from);
    immutable(r, from);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length !== f.bytes || sha(body) !== f.sha256) throw Error(`${from} is not the file the list names`);
    objects.push(object(`assets/app/${f.name}`, from, body));
  }
  const marker = Buffer.from(JSON.stringify({ schema: APP_FILES, set: list.set, files }) + '\n');
  objects.push({ key: `assets/app/sets/${list.set}.json`, from: null, contentType: TYPES.json, bytes: marker.length, sha256: sha(marker), body: marker, stored: marker });
  return { set: list.set, page: url.href, objects };
}

const publicRow = ({ body, stored, ...o }) => o;

/** Stores `objects` in order (write once, verify, read back); the first failure stops the run, so a set's marker (last)
 *  is never written over a partial set. `credentials` as publish.mjs loads them. */
export async function store(planned, { credentials, fetcher = fetch, now } = {}) {
  const results = [];
  for (const o of planned.objects) if (!allowedKey(o.key) || !o.contentType) throw Error(`not a first-load key: ${o.key}`);
  if (planned.version && planned.objects.some((o) => !o.key.startsWith(`assets/replica/${planned.version}/`))) throw Error('not a replica key of this version');
  if (planned.set && planned.objects.at(-1).key !== `assets/app/sets/${planned.set}.json`) throw Error('the set marker must be last');
  for (const o of planned.objects) {
    const url = new URL(`/${BUCKET}/${o.key}`, ENDPOINT), br = o.encoding === 'br';
    const request = (method, body, headers = {}, unsigned = {}) => fetcher(url.href, { method, headers: { ...sigv4Headers({ url, method, credentials, body: body ?? Buffer.alloc(0), headers, now }), ...unsigned }, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(180_000) });
    const same = (r) => r.headers.get('x-amz-meta-sha256') === o.sha256 && r.headers.get('content-encoding') === (br ? 'br' : null) && r.headers.get('content-type') === o.contentType && r.headers.get('cache-control') === CACHE;
    let disposition = 'existing';
    const head = await request('HEAD');
    if (head.status === 404) {
      const put = await request('PUT', o.stored, { 'if-none-match': '*', 'content-type': o.contentType, 'cache-control': CACHE, ...(br ? { 'content-encoding': 'br' } : {}), 'x-amz-meta-sha256': o.sha256 });
      await put.body?.cancel();
      if (put.status === 412) { const raced = await request('HEAD'); if (raced.status !== 200 || !same(raced)) throw Error(`immutable key conflict after a racing PUT: ${o.key}`); }
      else if (!put.ok) throw Error(`PUT failed (${put.status}) for ${o.key}`);
      else disposition = 'uploaded';
    } else if (head.status !== 200) throw Error(`HEAD failed (${head.status}) for ${o.key}`);
    else if (!same(head)) throw Error(`refusing to overwrite ${o.key}: it holds other bytes or headers`);
    const back = await request('GET', undefined, {}, { 'accept-encoding': br ? 'br' : 'identity' });   // fetch decodes: the body is the file itself
    if (back.status !== 200 || !same(back) || sha(Buffer.from(await back.arrayBuffer())) !== o.sha256) throw Error(`readback differs for ${o.key}`);
    results.push({ ...publicRow(o), disposition, verified: true });
  }
  return { version: 1, at: new Date().toISOString(), bucket: BUCKET, ...(planned.version ? { replica: planned.version } : {}), ...(planned.set ? { set: planned.set } : {}), ok: true, results };
}

/** The CDN's copies as a browser on the page's origin gets them: 200, the stored type, immutable, readable from that
 *  origin, and the bytes the origin serves. No credentials. → rows with `problems` (empty when fine). */
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
  const replica = await plan(page), app = await planApp(page);
  const total = (objects) => objects.reduce((n, x) => n + (x.storedBytes ?? x.bytes), 0);
  console.log(`replica ${replica.version}: ${replica.objects.length} files, ${total(replica.objects)} bytes stored`);
  console.log(app ? `web build set ${app.set}: ${app.objects.length - 1} files and its marker, ${total(app.objects)} bytes stored` : 'web build: the origin lists no file set (an older launcher, or a build that cannot be copied whole); skipped');
  const sets = [replica, ...(app ? [app] : [])], receipts = [];
  if (apply) {
    requireAccount();
    const credentials = await loadCredentials();
    for (const set of sets) {
      const receipt = await store(set, { credentials });
      receipts.push(receipt);
      const count = (d) => receipt.results.filter((r) => r.disposition === d).length;
      console.log(`${set.version ? 'replica' : 'web build'}: ${count('uploaded')} uploaded, ${count('existing')} already there, all read back`);
    }
    if (out) writeFileSync(out, JSON.stringify(receipts, null, 1) + '\n', { flag: 'wx' });
  }
  if (apply || only) {
    let bad = 0;
    for (const set of sets) {
      const rows = await check(set), wrong = rows.filter((r) => r.problems.length);
      console.log(`${set.version ? 'replica' : 'web build'} on ${CDN}: ${rows.length - wrong.length} of ${rows.length} as a browser needs them${wrong.length ? '\n' + JSON.stringify(wrong, null, 1) : ''}`);
      bad += wrong.length;
    }
    if (bad) process.exit(1);
  } else console.log('dry run: nothing stored. --apply stores these objects; --check reads the CDN\'s copies.');
}

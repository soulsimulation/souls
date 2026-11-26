// move-assets.mjs against two local S3 stand-ins: plan reads only, apply copies bytes and headers and resumes, verify
// catches a changed object, undo deletes only what apply created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { CORS_RULE, bucket, describe, run, same, selectKeys } from './move-assets.mjs';

const md5 = (b) => createHash('md5').update(b).digest('hex');
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A path-style S3 stand-in: ListObjectsV2 (two keys a page), GET, PUT (checks Content-MD5), DELETE. */
function standIn(name, key) {
  const objects = new Map(), calls = [];
  const failPut = new Set(), cors = {};
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${key}/`)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').slice(1);
    if (parts[0] !== name) { res.writeHead(404).end(); return; }
    const k = parts.slice(1).map(decodeURIComponent).join('/');
    calls.push(`${req.method} ${k}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (url.searchParams.has('cors')) {
        if (name === 'eden-assets') { res.writeHead(403).end(); return; }   // like the real source token
        if (req.method === 'PUT') { cors.xml = body.toString(); res.writeHead(200).end(); return; }
        if (!cors.xml) { res.writeHead(404).end(); return; }
        res.writeHead(200).end(cors.xml);
      } else if (req.method === 'GET' && !k) {
        const all = [...objects.keys()].sort(), start = Number(url.searchParams.get('continuation-token') ?? 0), page = all.slice(start, start + 2);
        const more = start + 2 < all.length;
        const xml = `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}${page.map((p) => `<Contents><Key>${p.replace(/&/g, '&amp;')}</Key><Size>${objects.get(p).body.length}</Size><ETag>&quot;${objects.get(p).etag}&quot;</ETag></Contents>`).join('')}</ListBucketResult>`;
        res.writeHead(200, { 'content-type': 'application/xml' }).end(xml);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const o = objects.get(k);
        if (!o) { res.writeHead(404).end(); return; }
        res.writeHead(200, { ...o.headers, etag: `"${o.etag}"`, 'content-length': o.body.length }).end(req.method === 'GET' ? o.body : undefined);
      } else if (req.method === 'PUT') {
        if (failPut.has(k)) { failPut.delete(k); res.writeHead(403).end(); return; }
        if (req.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) { res.writeHead(400).end(); return; }
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([h]) => /^(content-type|cache-control|content-encoding|content-disposition|content-language|expires|x-amz-meta-.*)$/.test(h)));
        objects.set(k, { body, headers, etag: md5(body) });
        res.writeHead(200, { etag: `"${md5(body)}"` }).end();
      } else if (req.method === 'DELETE') { objects.delete(k); res.writeHead(204).end(); } else res.writeHead(405).end();
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, objects, calls, failPut, endpoint: `http://127.0.0.1:${server.address().port}` })));
}

const put = (s, k, body, headers) => s.objects.set(k, { body: Buffer.from(body), headers, etag: md5(Buffer.from(body)) });

async function setup() {
  const src = await standIn('eden-assets', 'SRCKEY'), dst = await standIn('soul-game-assets', 'DSTKEY');
  const glb = Buffer.from('glTF model bytes');
  put(src, `assets/ab/${sha(glb)}.glb`, glb, { 'content-type': 'model/gltf-binary', 'cache-control': 'public, max-age=31536000, immutable', 'x-amz-meta-sha256': sha(glb), 'x-amz-meta-licence': 'CC0-1.0' });
  const plain = Buffer.from('{"a":1}'.repeat(50)), br = brotliCompressSync(plain);
  put(src, `assets/br/cd/${sha(plain)}.json`, br, { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable', 'content-encoding': 'br', 'x-amz-meta-sha256': sha(plain), 'x-amz-meta-encoded-sha256': sha(br) });
  put(src, 'w/eden/assets/' + 'e'.repeat(64) + '.png', 'png', { 'content-type': 'image/png' });
  put(src, 'readme/v4/hero.webp', 'webp', { 'content-type': 'image/webp' });
  put(src, 'proofs/pr-1/clip.mp4', 'old clip', { 'content-type': 'video/mp4' });
  put(src, 'proofs/pr-2/linked.png', 'linked', { 'content-type': 'image/png' });
  const from = bucket({ endpoint: src.endpoint, name: 'eden-assets', accessKeyId: 'SRCKEY', secretAccessKey: 's' });
  const to = bucket({ endpoint: dst.endpoint, name: 'soul-game-assets', accessKeyId: 'DSTKEY', secretAccessKey: 'd' });
  const opts = { from, to, state: mkdtempSync(join(tmpdir(), 'move-assets-')), proofs: new Set(['proofs/pr-2/linked.png']), references: new Set([`assets/ab/${sha(glb)}.glb`]) };
  return { src, dst, opts, close: () => { src.server.close(); dst.server.close(); } };
}

test('plan reads both listings, writes nothing, and leaves unlinked proofs out', async () => {
  const t = await setup();
  try {
    const r = await run('plan', t.opts);
    assert.equal(r.source.objects, 6);
    assert.equal(r.moves.objects, 5);
    assert.equal(r.excludedProofs.count, 1);
    assert.equal(r.toCopy.objects, 5);
    assert.deepEqual(r.references.missingFromSource, []);
    assert.ok(t.src.calls.every((c) => c.startsWith('GET ')) && t.dst.calls.every((c) => c.startsWith('GET ')));
    assert.equal(t.dst.objects.size, 0);
    assert.match(describe(r), /to copy 5/);
  } finally { t.close(); }
});

test('apply copies identical bytes and headers (brotli stays encoded), resumes after a failure, verify passes', async () => {
  const t = await setup();
  try {
    const brKey = [...t.src.objects.keys()].find((k) => k.startsWith('assets/br/'));
    t.dst.failPut.add('readme/v4/hero.webp');
    const first = await run('apply', t.opts);
    assert.equal(first.copied.objects, 4);
    assert.equal(first.failed.length, 1);
    assert.equal((await run('verify', t.opts)).ok, false);
    const second = await run('apply', t.opts);
    assert.equal(second.copied.objects, 1, 'only the failed key is copied again');
    assert.equal((await run('apply', t.opts)).copied.objects, 0, 'a finished copy has nothing left');
    for (const [k, o] of t.dst.objects) {
      assert.deepEqual(o.body, t.src.objects.get(k).body, k);
      assert.deepEqual(o.headers, t.src.objects.get(k).headers, k);
    }
    assert.equal(t.dst.objects.get(brKey).headers['content-encoding'], 'br');
    assert.ok(!t.dst.objects.has('proofs/pr-1/clip.mp4') && t.dst.objects.has('proofs/pr-2/linked.png'));
    const v = await run('verify', { ...t.opts, deep: true });
    assert.equal(v.ok, true, describe(v));
    assert.equal(v.journalSha, 5);
    assert.equal(v.deep.badCount, 0);
  } finally { t.close(); }
});

test('verify fails on a target object changed since; apply keeps it unless forced', async () => {
  const t = await setup();
  try {
    await run('apply', t.opts);
    put(t.dst, 'readme/v4/hero.webp', 'WEBP', { 'content-type': 'image/webp' });
    const v = await run('verify', t.opts);
    assert.equal(v.ok, false);
    assert.deepEqual(v.differs, ['readme/v4/hero.webp']);
    assert.equal((await run('apply', t.opts)).differsKept, 1);
    assert.equal(t.dst.objects.get('readme/v4/hero.webp').body.toString(), 'WEBP');
    await run('apply', { ...t.opts, force: true });
    assert.equal((await run('verify', t.opts)).ok, true);
  } finally { t.close(); }
});

test('a source body that does not match its ETag is never written', async () => {
  const t = await setup();
  try {
    t.src.objects.get('readme/v4/hero.webp').etag = md5(Buffer.from('other'));
    const r = await run('apply', t.opts);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0], /MD5 differs/);
    assert.ok(!t.dst.objects.has('readme/v4/hero.webp'));
  } finally { t.close(); }
});

test('undo needs --yes and deletes only objects apply created that are unchanged; the source is untouched', async () => {
  const t = await setup();
  try {
    put(t.dst, 'w/other/assets/' + 'f'.repeat(64) + '.glb', 'uploaded on the new CDN', { 'content-type': 'model/gltf-binary' });
    await run('apply', t.opts);
    put(t.dst, 'readme/v4/hero.webp', 'changed', { 'content-type': 'image/webp' });
    await assert.rejects(run('undo', t.opts), /--yes/);
    const u = await run('undo', { ...t.opts, yes: true });
    assert.equal(u.deleted, 4);
    assert.equal(u.keptChanged, 1);
    assert.deepEqual([...t.dst.objects.keys()].sort(), ['readme/v4/hero.webp', 'w/other/assets/' + 'f'.repeat(64) + '.glb']);
    assert.equal(t.src.objects.size, 6);
    assert.ok(t.src.calls.every((c) => c.startsWith('GET ')));
  } finally { t.close(); }
});

test('same() and selectKeys()', () => {
  const j = new Map([['k', { srcEtag: 'abc-2', dstEtag: 'def' }]]);
  assert.equal(same({ key: 'k', size: 1, etag: 'abc-2' }, { size: 1, etag: 'def' }, j), true, 'a multipart source copied here');
  assert.equal(same({ key: 'k', size: 1, etag: 'abc-2' }, { size: 2, etag: 'def' }, j), false);
  assert.equal(same({ key: 'x', size: 1, etag: 'a' }, { size: 1, etag: 'a' }, new Map()), true);
  const src = new Map([['proofs/a', { size: 3 }], ['assets/b', { size: 4 }]]);
  assert.equal(selectKeys(src).chosen.size, 1);
  assert.equal(selectKeys(src, { allProofs: true }).chosen.size, 2);
});

test('cors: the built-in rule when the source token may not read it; --apply sets it on the target once', async () => {
  const t = await setup();
  try {
    const before = await run('cors', t.opts);
    assert.equal(before.same, false);
    assert.deepEqual(before.targetOrigins, []);
    assert.deepEqual(before.dashboardJson, CORS_RULE);
    const applied = await run('cors', { ...t.opts, applyCors: true });
    assert.equal(applied.applied, true);
    const after = await run('cors', { ...t.opts, applyCors: true });
    assert.equal(after.same, true);
    assert.equal(after.applied, false);
    assert.deepEqual(after.targetOrigins, ['https://sim.eden.art', 'https://soul.game', 'https://souls.game']);
    assert.match(describe(after), /rules match/);
  } finally { t.close(); }
});

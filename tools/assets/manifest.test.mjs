// The media manifest and the repository agree: every pulled path is git-ignored and untracked, the only binaries in
// git are the small allowlisted ones, nothing dropped comes back, and pull.mjs places and verifies files correctly.
// Offline: no network (the fetch test uses a stub).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, fetchVerified, globToRegExp, loadManifest, run, select } from './pull.mjs';

const git = (args, input) => execFileSync('git', args, { cwd: ROOT, input, maxBuffer: 1 << 26 }).toString();
const MEDIA = /\.(glb|gltf|bin|drc|ktx2|basis|hdr|exr|fbx|obj|blend|usdz|png|jpe?g|webp|avif|gif|bmp|tiff?|heic|psd|mp3|ogg|oga|wav|flac|m4a|aac|opus|mp4|m4v|webm|mov|mkv|db|sqlite\d?|zip|tar|tgz|gz|7z|pdf)$/i;
// Same list as the negations in the root .gitignore (and the media audit's keep list).
const KEEP = [/^apps\/web\/pwa\/icon-(\d+|mark|social)\.png$/, /^apps\/web\/src\/media\/gallery-loop\.mp4$/, /^tools\/god-skill\/reference\/kit-primitives\.png$/, /^tools\/playtest\/review\/fixtures\/runs\/.+\.png$/, /^apps\/server\/test\/fixtures\/sample-texture\.jpg$/,
  // The released Soul client, gzipped text, for the upgrade compatibility test (#1938).
  /^tools\/world-launcher\/soul\/released\/2\.32\.0\/(eden\.mjs|skill\.md)\.gz$/];
// Dropped by decision: the Mars archive photo gallery, its captions and the 2020 evidence strip are never pulled or
// committed. Under history/ and 2020/ only the wall, mural, sign and Portal screen texture crops are media.
const DROPPED = /^mars\/viewer\/public\/(2020\/evidence\/|(history|2020)\/.*\.(json|html|md)$)|discord/i;

test('manifest entries are well formed, unique and exclude dropped media', async () => {
  const m = await loadManifest();
  assert.ok(m.files.length > 1000);
  for (const f of m.files) {
    assert.doesNotMatch(f.path, DROPPED, f.path);
    if (f.symlink === undefined) assert.ok(f.url.startsWith(`${m.cdn}/assets/`) && f.url.includes(f.sha256), f.path);
  }
});

test('every manifest path is git-ignored and untracked', async () => {
  const paths = (await loadManifest()).files.map(f => f.path);
  const notIgnored = git(['check-ignore', '--no-index', '--stdin', '-v', '-n'], paths.join('\n')).split('\n').filter(l => l.startsWith('::'));
  assert.deepEqual(notIgnored, []);
  const tracked = new Set(git(['ls-files', '-z']).split('\0'));
  assert.deepEqual(paths.filter(p => tracked.has(p)), []);
});

test('the only tracked binaries are the allowlisted ones', () => {
  const extra = git(['ls-files', '-z']).split('\0').filter(p => MEDIA.test(p) && !KEEP.some(k => k.test(p)) && !/\.jsonl\.br$/.test(p));
  assert.deepEqual(extra, []);
});

test('globs: ** crosses directories, * does not, a trailing / takes the subtree', () => {
  assert.ok(globToRegExp('worlds/**/*.glb').test('worlds/a/b/c.glb'));
  assert.ok(globToRegExp('worlds/**/*.glb').test('worlds/c.glb'));
  assert.ok(!globToRegExp('worlds/*.glb').test('worlds/a/c.glb'));
  assert.ok(globToRegExp('mars/viewer/').test('mars/viewer/public/x.png'));
  assert.ok(!globToRegExp('apps/web/**').test('apps/webx/a.mp3'));
  const files = [{ path: 'a/x.glb', set: 'runtime' }, { path: 'b/y.png', set: 'test' }];
  assert.deepEqual(select(files, { sets: ['runtime'] }).map(f => f.path), ['a/x.glb']);
  assert.deepEqual(select(files, { sets: ['runtime', 'test'], only: ['b/**'] }).map(f => f.path), ['b/y.png']);
});

test('pull downloads, verifies, caches, links and is idempotent; a wrong body fails without landing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'souls-assets-test-'));
  try {
    const good = Buffer.from('good bytes'), bad = Buffer.from('bad bytes!');
    const sha = b => createHash('sha256').update(b).digest('hex');
    const manifest = { version: 1, cdn: 'https://cdn.test', files: [
      { path: 'w/a.glb', sha256: sha(good), bytes: good.length, url: 'https://cdn.test/assets/a.glb', set: 'runtime' },
      { path: 'w/b.glb', sha256: sha(good), bytes: good.length, url: 'https://cdn.test/assets/bad.glb', set: 'runtime' },
      { path: 'w/link.glb', symlink: 'a.glb', set: 'runtime' },
      { path: 'w/c.png', sha256: sha(bad), bytes: bad.length, url: 'https://cdn.test/assets/gone.png', set: 'test' },
    ] };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const calls = [];
    const fetcher = async url => { calls.push(url); return url.endsWith('/a.glb') ? new Response(good) : url.endsWith('/bad.glb') ? new Response(bad) : new Response('no', { status: 404 }); };
    const opts = { manifest: join(dir, 'manifest.json'), dest: join(dir, 'tree'), cache: join(dir, 'cache'), fetcher, quiet: true, log: () => {} };
    // b.glb shares a.glb's sha256, so whichever runs second is served from the cache: run them one at a time.
    const first = await run({ ...opts, concurrency: 1 });
    assert.deepEqual(first.failed.map(f => f.path), ['w/c.png']);
    assert.equal(await readFile(join(dir, 'tree/w/a.glb'), 'utf8'), 'good bytes');
    assert.equal(await readFile(join(dir, 'tree/w/b.glb'), 'utf8'), 'good bytes');
    assert.equal(await readlink(join(dir, 'tree/w/link.glb')), 'a.glb');
    calls.length = 0;
    const again = await run({ ...opts, sets: ['runtime'] });
    assert.deepEqual([again.failed, calls, again.counts], [[], [], { ok: 3 }]);
    const check = await run({ ...opts, check: true });
    assert.deepEqual(check.failed, [{ path: 'w/c.png', error: 'missing' }]);
    // a body with the wrong hash never lands in the tree or the cache
    const fresh = await run({ ...opts, dest: join(dir, 'tree2'), cache: join(dir, 'cache2'), only: ['w/b.glb'] });
    assert.match(fresh.failed[0].error, /want 10 bytes/);
    await assert.rejects(readFile(join(dir, 'tree2/w/b.glb')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pull retries transient failures with backoff and reports every failed path and why, even quiet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'souls-assets-test-'));
  try {
    const body = Buffer.from('media bytes'), sha256 = createHash('sha256').update(body).digest('hex');
    const names = ['flaky', 'reset', 'stall', 'slow503', 'gone', 'wrong'];
    const manifest = { version: 1, files: names.map(n => ({ path: `m/${n}.glb`, sha256, bytes: body.length, url: `https://cdn.test/${n}`, set: 'runtime' })) };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const calls = {};
    // A body that sends a few bytes and then nothing, until the request's signal aborts it.
    const stalled = signal => new Response(new ReadableStream({ start(c) { c.enqueue(body.subarray(0, 3)); signal.addEventListener('abort', () => c.error(signal.reason)); } }));
    const fetcher = async (url, { signal }) => {
      const n = url.split('/').pop(), k = (calls[n] = (calls[n] || 0) + 1);
      if (n === 'flaky') return k < 3 ? new Response('busy', { status: 503 }) : new Response(body);
      if (n === 'reset') { if (k < 2) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return new Response(body); }
      if (n === 'stall') return stalled(signal);
      if (n === 'slow503') return new Response('busy', { status: 503 });
      if (n === 'gone') return new Response('no', { status: 404 });
      return new Response('other bytes');
    };
    const lines = [];
    const r = await run({ manifest: join(dir, 'manifest.json'), dest: join(dir, 'tree'), cache: join(dir, 'cache'), fetcher, quiet: true,
      tries: 3, stallMs: 50, backoffMs: 1, log: m => lines.push(m) });
    assert.equal(await readFile(join(dir, 'tree/m/flaky.glb'), 'utf8'), 'media bytes');
    assert.equal(await readFile(join(dir, 'tree/m/reset.glb'), 'utf8'), 'media bytes');
    assert.deepEqual(calls, { flaky: 3, reset: 2, stall: 3, slow503: 3, gone: 1, wrong: 1 });
    const why = Object.fromEntries(r.failed.map(f => [f.path, f.error]));
    assert.deepEqual(Object.keys(why).sort(), ['m/gone.glb', 'm/slow503.glb', 'm/stall.glb', 'm/wrong.glb']);
    assert.equal(why['m/stall.glb'], 'timeout: stalled, no data for 0.05 s after 3 of 11 bytes (after 3 tries)');
    assert.equal(why['m/slow503.glb'], 'HTTP 503 (after 3 tries)');
    assert.equal(why['m/gone.glb'], 'HTTP 404 (not published?)');
    assert.match(why['m/wrong.glb'], /^hash mismatch: got 11 bytes/);
    for (const [path, error] of Object.entries(why)) assert.ok(lines.includes(`assets: FAILED ${path}: ${error} (https://cdn.test/${path.slice(2, -4)})`), path);
    assert.ok(lines.includes('assets: retrying m/reset.glb (try 2 of 3): network: ECONNRESET'));
    assert.ok(lines.includes('assets: retrying m/flaky.glb (try 3 of 3): HTTP 503'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a request with no response at all times out instead of hanging', async () => {
  const f = { sha256: '0'.repeat(64), bytes: 1 };
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(fetchVerified('https://cdn.test/x', f, null, { fetcher: hang, tries: 2, stallMs: 30, backoffMs: 1 }),
    { message: 'timeout: no response in 0.03 s (after 2 tries)' });
});

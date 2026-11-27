// #4986: the web build's own files as a set the asset CDN can hold whole; the launcher lists them, and tells a routed
// page to load its code from the CDN only once it has seen that set's marker there.
//   node --test tools/world-launcher/app-files.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_FILE, APP_FILES, appFiles, listAppFiles, setOf } from './app-files.mjs';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const scratch = new URL('../../.local/', import.meta.url).pathname;
mkdirSync(scratch, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const BUILD = { 'main-Dqe4hDOV.js': 'import "./vendor-V87T1nx1.js";', 'vendor-V87T1nx1.js': 'export const three = 3;', 'main-DeE5v0m5.css': '.a{}', 'kind-looks-BgoB7tkf.json': '{}', 'sim-icon-32-45d4ec648f.png': 'png', 'birds--VBo5PFJ.mp3': 'mp3' };
function build(dir, files = BUILD) { mkdirSync(join(dir, 'assets'), { recursive: true }); for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), body); return dir; }

test('a build file\'s name carries a content hash and a type a browser is served', () => {
  for (const name of [...Object.keys(BUILD), 'terrain-color.worker-BodHjsIY.js', 'activity-spots.v1-CmHM1xJY.js', 'draco_decoder-C32yEggz.wasm', 'gallery-loop-BNHiZJu9.mp4']) assert.equal(APP_FILE.test(name), true, name);
  for (const name of ['index.html', 'config.json', 'main.js', 'main-Dqe4hDOV.js.br', 'main-Dqe4hDOV.html', '../main-Dqe4hDOV.js', 'a/main-Dqe4hDOV.js', '.main-Dqe4hDOV.js', 'main-Dqe4hDOV.js?x=1', 'worlds.json']) assert.equal(APP_FILE.test(name), false, name);
});

test('the list: every file of assets/ by name, size and hash; the release\'s compressed copies are not files of their own', () => {
  const dir = build(mkdtempSync(join(scratch, 'app-files-')));
  try {
    writeFileSync(join(dir, 'assets', 'main-Dqe4hDOV.js.br'), 'br'); writeFileSync(join(dir, 'assets', 'main-Dqe4hDOV.js.gz'), 'gz'); writeFileSync(join(dir, 'index.html'), '<html>');
    const list = listAppFiles(dir);
    assert.equal(list.schema, APP_FILES);
    assert.deepEqual(list.files.map((f) => f.name), Object.keys(BUILD).sort());
    assert.deepEqual(list.files.find((f) => f.name === 'vendor-V87T1nx1.js'), { name: 'vendor-V87T1nx1.js', bytes: 23, sha256: sha(BUILD['vendor-V87T1nx1.js']) });
    assert.match(list.set, /^[0-9a-f]{32}$/); assert.equal(list.set, setOf([...list.files].reverse()), 'the set id does not depend on order');
    // one byte of one file changed: another set
    writeFileSync(join(dir, 'assets', 'kind-looks-BgoB7tkf.json'), '{ }');
    assert.notEqual(listAppFiles(dir).set, list.set);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a folder that cannot be copied whole has no set: a subfolder, a file without a hash, an orphan compressed copy, nothing at all', () => {
  for (const spoil of [(d) => mkdirSync(join(d, 'assets', 'sub')), (d) => writeFileSync(join(d, 'assets', 'config.json'), '{}'), (d) => writeFileSync(join(d, 'assets', 'notes.txt.br'), 'x'), (d) => rmSync(join(d, 'assets'), { recursive: true })]) {
    const dir = build(mkdtempSync(join(scratch, 'app-files-')));
    try { spoil(dir); assert.equal(listAppFiles(dir), null); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const empty = mkdtempSync(join(scratch, 'app-files-'));
  try { mkdirSync(join(empty, 'assets')); assert.equal(listAppFiles(empty), null); } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('appFiles reads the folder again only when it changes', () => {
  const dir = build(mkdtempSync(join(scratch, 'app-files-')));
  try {
    const files = appFiles(dir), first = files();
    assert.equal(files(), first, 'the same list, not read again');
    writeFileSync(join(dir, 'assets', 'next-AAAAbbbb.js'), 'next'); utimesSync(join(dir, 'assets'), new Date(), new Date(Date.now() + 5000));
    assert.notEqual(files().set, first.set);
    rmSync(join(dir, 'assets'), { recursive: true });
    assert.equal(files(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the launcher lists its build at /__sim/app-files.json, and names the CDN to a routed page only once the set\'s marker is there', async (t) => {
  const dir = mkdtempSync(join(scratch, 'app-files-launcher-')), data = join(dir, 'data'), clientDir = join(dir, 'served'), routesFile = join(dir, 'routes.json'), webDir = build(join(dir, 'web'));
  mkdirSync(data); mkdirSync(clientDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><head><title>Souls</title><link rel="canonical" href="https://x/"></head><body></body></html>');
  writeFileSync(join(clientDir, 'replica.js'), 'test module'); writeFileSync(join(clientDir, 'replica_bg.wasm'), 'test wasm');
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: ['/worlds'], worlds: [] }));
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { fresh: { gateway: 'http://127.0.0.1:7312', stream: '/s/fresh/', canonical: true } } }));
  const asked = [], marker = { there: false };
  const edgeFetch = async (url, init) => { asked.push(`${init.method} ${url}`); return new Response(null, marker.there && url.includes('/assets/app/sets/') ? { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable' } } : { status: 404 }); };
  const P = await testPort(3), base = `http://127.0.0.1:${P}`;
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, webDir, eager: 0, base: '/', log: () => {}, edgeFetch,
    cutoverBinding: { oldWorldId: 'eden-original-1', canonicalSlug: 'eden', routesFile, clientDir, firstLoadOrigin: 'https://cdn.soul.game' },
    command: () => { throw Error('no old process in this test'); } });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const listed = await fetch(`${base}/__sim/app-files.json`), list = await listed.json();
  assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list, listAppFiles(webDir));
  const config = async () => JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/s.exec(await (await fetch(`${base}/w/fresh/`, { headers: { accept: 'text/html' } })).text())[1]);
  const first = await config();
  assert.equal(first.v2Stream, '/s/fresh/'); assert.equal(first.appCdn, undefined, 'not seen on the CDN: the page loads this host\'s files');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(asked.includes(`HEAD https://cdn.soul.game/assets/app/sets/${list.set}.json`), 'the launcher looked for this build\'s marker');
  assert.equal((await config()).appCdn, undefined, 'still not there');
  // the marker appears (the mirror ran); the launcher looks again a minute later, which this test does not wait for:
  // a second launcher, as after a restart, sees it on its first look and tells the next page
  marker.there = true;
  const P2 = await testPort(3);
  const again = await openLauncher({ port: P2, range: [P2 + 1, P2 + 2], dataDir: data, webDir, eager: 0, base: '/', log: () => {}, edgeFetch,
    cutoverBinding: { oldWorldId: 'eden-original-1', canonicalSlug: 'eden', routesFile, clientDir, firstLoadOrigin: 'https://cdn.soul.game' }, command: () => { throw Error('no old process in this test'); } });
  t.after(() => again.close());
  const config2 = async () => JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/s.exec(await (await fetch(`http://127.0.0.1:${P2}/w/fresh/`, { headers: { accept: 'text/html' } })).text())[1]);
  await config2(); await new Promise((r) => setTimeout(r, 20));
  assert.equal((await config2()).appCdn, 'https://cdn.soul.game/assets/app/');
  // a build with a file that cannot be copied: no list, no marker asked for, the origin's files
  writeFileSync(join(webDir, 'assets', 'config.json'), '{}'); utimesSync(join(webDir, 'assets'), new Date(), new Date(Date.now() + 5000));
  assert.equal((await fetch(`http://127.0.0.1:${P2}/__sim/app-files.json`)).status, 404);
  assert.equal((await config2()).appCdn, undefined);
});

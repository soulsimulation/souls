// node --test tools/world-launcher/moved-assets.test.mjs (launcher, a fake world, a stand-in release and upload store)
// A moved world has no old process (D2b), so its page's /asset-view/<sha>.glb and /assets/<sha>.<ext> are the
// launcher's: a god's uploads from the shared upload store (immutable), a core mesh from the release (its rendition,
// revalidated), the kept brotli copy when the browser takes it, and 404 no-store only when the asset is truly absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('a moved world\'s uploaded models and pictures, and its core meshes, are served without an old process', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-moved-assets-'));
  const templatesDir = join(dir, 'templates'), webDir = join(dir, 'web'), release = join(dir, 'release'), store = join(dir, 'store');
  for (const p of [templatesDir, webDir, join(release, 'worlds/core-assets/renditions'), join(store, 'wire')]) mkdirSync(p, { recursive: true });
  // the god's uploads: a GLB (with its kept brotli copy) and a JPEG, each beside its meta
  const glb = Buffer.from('glTF upload bytes '.repeat(200)), jpg = Buffer.from('jpeg upload bytes'), glbSha = sha(glb), jpgSha = sha(jpg);
  writeFileSync(join(store, `${glbSha}.glb`), glb); writeFileSync(join(store, `${glbSha}.meta.json`), JSON.stringify({ sha: glbSha, ext: 'glb', kind: 'mesh' }));
  writeFileSync(join(store, 'wire', `${glbSha}.glb.br`), brotliCompressSync(glb));
  writeFileSync(join(store, `${jpgSha}.jpg`), jpg); writeFileSync(join(store, `${jpgSha}.meta.json`), JSON.stringify({ sha: jpgSha, ext: 'jpg', kind: 'image' }));
  // the release's core mesh and its smaller rendition
  const core = Buffer.from('core source'), coreSha = sha(core), ren = Buffer.from('core rendition'), renSha = sha(ren);
  writeFileSync(join(release, 'worlds/core-assets/core.glb'), core); writeFileSync(join(release, 'worlds/core-assets/renditions/r.glb'), ren);
  writeFileSync(join(release, 'worlds/core-assets/index.json'), JSON.stringify({ schema: 'core-assets/1', assets: { [coreSha]: { ext: 'glb', kind: 'mesh', path: 'worlds/core-assets/core.glb' } } }));
  writeFileSync(join(release, 'worlds/core-assets/renditions.json'), JSON.stringify({ schema: 'core-renditions/1', renditions: { [coreSha]: { sha: renSha, path: 'worlds/core-assets/renditions/r.glb', bytes: ren.length } } }));

  const P = await testPort(5), base = `http://127.0.0.1:${P + 4}`, fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const binding = join(dir, 'binding.json'), routesFile = join(dir, 'routes.json');
  const L = await openLauncher({ port: P + 4, range: [P, P + 3], dataDir: join(dir, 'data'), webDir, templatesDir, eager: 0, log: () => {}, cutoverBindingFile: binding,
    coreAssetRoot: release, assetDir: store, command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } }) });
  t.after(async () => { await L.close(); rmSync(dir, { recursive: true, force: true }); });
  const r = await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eden' }) });
  assert.equal(r.status, 201); const eden = (await r.json()).slug;
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { canonical: true, stream: '/s/eden/' } } }));
  writeFileSync(binding, JSON.stringify({ oldWorldId: `${eden}-1`, canonicalSlug: 'eden', routesFile, clientDir: dir }));
  await new Promise((ok) => setTimeout(ok, 1100));   // the launcher looks at the binding file once a second
  const get = (path, headers = {}, method = 'GET') => fetch(`${base}/w/${eden}${path}`, { method, headers: { 'accept-encoding': 'identity', ...headers } });

  const view = await get(`/asset-view/${glbSha}.glb`);
  assert.equal(view.status, 200, 'an uploaded model of a moved world is served');
  assert.equal(view.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(view.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(view.headers.get('etag'), `"${glbSha}"`);
  assert.deepEqual(Buffer.from(await view.arrayBuffer()), glb);
  const same = await get(`/asset-view/${glbSha}.glb`, { 'if-none-match': `"${glbSha}"` });
  assert.equal(same.status, 304); await same.arrayBuffer();
  const br = await get(`/asset-view/${glbSha}.glb`, { 'accept-encoding': 'gzip, br' });
  assert.equal(br.headers.get('content-encoding'), 'br', 'the kept brotli copy when the browser takes it');
  assert.deepEqual(Buffer.from(await br.arrayBuffer()), glb, 'fetch decodes it to the same bytes');

  const pic = await get(`/assets/${jpgSha}.jpg`);
  assert.equal(pic.status, 200, 'an uploaded picture is served');
  assert.equal(pic.headers.get('content-type'), 'image/jpeg');
  assert.equal(pic.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await pic.arrayBuffer()), jpg);
  const head = await get(`/assets/${glbSha}.glb`, {}, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(glb.length));

  const coreView = await get(`/asset-view/${coreSha}.glb`);
  assert.equal(coreView.status, 200, 'a core mesh is its release rendition');
  assert.equal(coreView.headers.get('cache-control'), 'public, no-cache');
  assert.equal(coreView.headers.get('etag'), `"${coreSha}-r${renSha.slice(0, 16)}"`);
  assert.deepEqual(Buffer.from(await coreView.arrayBuffer()), ren);

  for (const path of [`/asset-view/${'f'.repeat(64)}.glb`, `/assets/${'e'.repeat(64)}.png`, `/assets/${jpgSha}.png`, `/assets/${coreSha}.jpg`]) {
    const missing = await get(path);
    assert.equal(missing.status, 404, path); assert.equal(missing.headers.get('cache-control'), 'no-store', path); await missing.arrayBuffer();
  }
  const other = await get('/v1/world/somewhere');
  assert.equal(other.status, 404); assert.equal((await other.json()).code, 'world.new-engine', 'every other old route is still the new engine\'s');
});

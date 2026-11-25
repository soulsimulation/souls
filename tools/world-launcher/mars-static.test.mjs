// node --test tools/world-launcher/mars-static.test.mjs  (a free block of ports; no world processes)
// 0.133.2: once Eden moved to the new engine no old world process ran, and the site-level Mars static files the old
// root world answered (apps/server/src/mars-static.ts) were the launcher's own 404: /mars-assets/static-manifest.json and
// campus-manifest.json among them, which the release's Mars web overlay (tools/playtest/arena/assets-overlay.mjs) fetches.
// The launcher now answers them from its mars-web, with mars-static.ts's cache policy, whatever is awake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { buildOverlay } from '../playtest/arena/assets-overlay.mjs';
import { MARS_STATIC_CACHE } from '../../apps/server/src/mars-static.ts';
import { testPort } from '../../apps/server/test/test-port.ts';
const P0 = await testPort(8);

const sha = (s) => createHash('sha256').update(s).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'launcher-mars-static-'));
const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
const marsWebDir = join(dir, 'mars-web');
for (const d of ['draco', 'browser', 'engine', 'data']) mkdirSync(join(marsWebDir, d), { recursive: true });
const draco = { 'draco_decoder.js': 'js', 'draco_decoder.wasm': 'wasm', 'draco_wasm_wrapper.js': 'wrap' };
for (const [n, body] of Object.entries(draco)) writeFileSync(join(marsWebDir, 'draco', n), body);
writeFileSync(join(marsWebDir, 'static-manifest.json'), JSON.stringify({ files: Object.entries(draco).map(([name, b]) => ({ name, bytes: b.length, sha256: sha(b) })) }));
writeFileSync(join(marsWebDir, 'browser', 'campus.glb'), 'glTF-campus');
writeFileSync(join(marsWebDir, 'campus-manifest.json'), JSON.stringify({ sha256: sha('glTF-campus') }));
writeFileSync(join(marsWebDir, 'engine', 'manifest.json'), '{"engine":1}');
writeFileSync(join(marsWebDir, 'data', 'manifest.json'), '{"data":1}');
writeFileSync(join(marsWebDir, 'index.html'), '<!doctype html>lab');
writeFileSync(join(marsWebDir, 'simulation-agent-guide.md'), '# not served');
writeFileSync(join(dir, 'secret.json'), '{}');
const command = () => ({ cmd: process.execPath, args: ['-e', ''] });
// as production runs it: the site at the root, no world awake
const L = await openLauncher({ port: P0, range: [P0 + 1, P0 + 3], dataDir: join(dir, 'data'), webDir, templatesDir, marsWebDir, command, eager: 0, log: () => {} });
after(() => L.close?.());
const origin = `http://127.0.0.1:${P0}`;

test('the site-level Mars static files are answered from mars-web with the old server\'s cache policy', async () => {
  for (const [p, body] of [['/mars-assets/campus-manifest.json', JSON.stringify({ sha256: sha('glTF-campus') })], ['/mars-assets/draco/draco_decoder.wasm', 'wasm'], ['/browser/campus.glb', 'glTF-campus'], ['/engine/manifest.json', '{"engine":1}'], ['/data/manifest.json', '{"data":1}']]) {
    const r = await fetch(origin + p);
    assert.equal(r.status, 200, p); assert.equal(await r.text(), body, p);
    assert.equal(r.headers.get('cache-control'), MARS_STATIC_CACHE, p);
  }
  assert.equal((await fetch(`${origin}/mars-assets/draco/draco_decoder.wasm`)).headers.get('content-type'), 'application/wasm');
});

test('nothing else in mars-web, or outside it, is served this way', async () => {
  for (const p of ['/mars-assets/index.html', '/mars-assets/simulation-agent-guide.md', '/mars-assets/../secret.json', '/mars-assets/%2e%2e/secret.json', '/mars-assets/missing.json', '/engine/../secret.json', '/browser/missing.glb']) {
    const r = await fetch(origin + p); await r.arrayBuffer();
    assert.notEqual(r.status, 200, p);
  }
});

test('the release\'s Mars web overlay step fetches its manifests, Draco files and campus model from the launcher', async () => {
  const out = join(dir, 'overlay');
  const m = await buildOverlay(out, { origin, only: ['manifests', 'draco', 'browser'], concurrency: 2 });
  assert.equal(m.ok, true, JSON.stringify(m.missing));
  assert.deepEqual(m.files.map((f) => f.rel), ['browser/campus.glb', 'campus-manifest.json', 'draco/draco_decoder.js', 'draco/draco_decoder.wasm', 'draco/draco_wasm_wrapper.js', 'static-manifest.json']);
});

test('under a --base the same root paths are answered with no world awake', async () => {
  const B = await openLauncher({ port: P0 + 4, range: [P0 + 5, P0 + 7], base: '/worlds', dataDir: join(dir, 'base-data'), webDir, templatesDir, marsWebDir, command, eager: 0, log: () => {} });
  try {
    const r = await fetch(`http://127.0.0.1:${P0 + 4}/mars-assets/static-manifest.json`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), MARS_STATIC_CACHE);
    assert.ok((await r.json()).files.length === 3);
  } finally { await B.close(); }
});

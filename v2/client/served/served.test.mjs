// The served set and the release's manifest (Engine v2 R17, #2818): what `release.sh bundle` puts in client.tar is
// what build.mjs describes in soul-client.json and what the manifest names, file by file. Needs no build: the
// release's programs and the daemon's library are stand-ins here (their bytes are not what is checked).

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { answer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../..');
const dir = mkdtempSync(join(tmpdir(), 'souls-r17-served-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('A2: each served file\'s version, length and hash equal the manifest\'s', () => {
  const bins = join(dir, 'bins'), page = join(dir, 'page'), pkg = join(dir, 'pkg'), out = join(dir, 'bundle'), x = join(dir, 'x');
  for (const d of [bins, page, pkg, x]) mkdirSync(d);
  for (const b of ['worldd', 'gatewayd', 'directoryd', 'deploy', 'gateway-upgrade', 'world-aside', 'assets-check']) writeFileSync(join(bins, b), `#!/bin/sh\n# ${b}\n`);
  writeFileSync(join(page, 'index.html'), '<!doctype html>');
  writeFileSync(join(pkg, 'replica.js'), 'export function initSync() {}\n');
  writeFileSync(join(pkg, 'replica_bg.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  const r = spawnSync('bash', [join(v2, 'tools/ops/release/release.sh'), 'bundle', out, 'a'.repeat(40), '2.5.0', bins, page, join(v2, 'client'), pkg], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  spawnSync('tar', ['-xf', join(out, 'artifacts/client.tar'), '-C', x]);
  const client = JSON.parse(readFileSync(join(x, 'soul-client.json'), 'utf8'));
  // creator.md joins them once G7 (#2796) adds v2/client/skills/creator.md.
  assert.deepEqual(manifest.served.map((f) => f.served).sort(), client.files.map((f) => f.name));
  for (const n of ['eden.mjs', 'instructions.md', 'replica.js', 'replica_bg.wasm', 'skill.md']) assert.ok(client.files.some((f) => f.name === n), n);
  const rows = [];
  for (const m of manifest.served) {
    const bytes = readFileSync(join(x, m.served)), d = client.files.find((f) => f.name === m.served);
    assert.deepEqual({ version: d.version, hash: `1220${d.sha256}`, bytes: d.bytes }, { version: m.version, hash: m.hash, bytes: m.bytes }, m.served);
    assert.deepEqual({ hash: `1220${sha(bytes)}`, bytes: bytes.length }, { hash: m.hash, bytes: m.bytes }, `${m.served} on disk`);
    rows.push(`${m.served} ${m.version} ${m.bytes} ${m.hash.slice(0, 16)}`);
  }
  assert.equal(manifest.version, '2.5.0');
  // The frozen parts: one version line, `name: souls`, and soulClient's shape for the client and its skill.
  const eden = readFileSync(join(x, 'eden.mjs'), 'utf8');
  assert.deepEqual(eden.match(/^const VERSION = "[^"]*";$/gm), ['const VERSION = "2.5.0";']);
  assert.match(readFileSync(join(x, 'skill.md'), 'utf8'), /^---\nname: souls\n[\s\S]*version: "2.5.0"/);
  assert.deepEqual(Object.keys(client).slice(0, 6), ['contract', 'version', 'bytes', 'sha256', 'minVersion', 'skill']);
  assert.deepEqual({ v: client.version, b: client.bytes, s: client.sha256 }, { v: '2.5.0', b: Buffer.byteLength(eden), s: sha(Buffer.from(eden)) });
  // Served at a world's address: /v1/config gives soulClient, a file its bytes.
  assert.deepEqual(JSON.parse(answer(x, '/w/eden/v1/config').body).soulClient, client);
  assert.deepEqual(answer(x, '/w/eden/eden.mjs').body, Buffer.from(eden));
  assert.equal(answer(x, '/w/eden/soul-client.json'), null);
  console.log(`A2: manifest served rows equal soul-client.json and the bytes:\n  ${rows.join('\n  ')}`);
});

test('the served client carries the land verbs\' ground model and its zod (#3695): land loads from the unpacked client', async () => {
  const { build } = await import('./build.mjs');
  const out = join(dir, 'land-served'), home = join(dir, 'land-home');
  build({ out, version: '2.5.1', strict: true });
  const r = spawnSync(process.execPath, [join(out, 'eden.mjs'), 'version'], { encoding: 'utf8', env: { ...process.env, SOULS_HOME: join(home, '.souls') } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [root] = readdirSync(join(home, '.souls/bin/client')).filter((d) => d.startsWith('2.5.1-'));
  const unpacked = join(home, '.souls/bin/client', root);
  assert.ok(existsSync(join(unpacked, 'node_modules/zod/package.json')), 'zod rides along');
  // The daemon imports the land verbs this way (`worldBatch`); a client without zod refused them `land.unavailable`.
  const land = await import(pathToFileURL(join(unpacked, 'v2/client/src/creator/terrain/land.mjs')).href);
  assert.equal(typeof land.landOps, 'function');
});

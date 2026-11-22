import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { bodyAssetFiles, humanoidKitFiles } from './body-assets.ts';
import { KIT_SHA256, kitFiles } from './src/crowd/humanoid/kit-pin.ts';
const repo = resolve(import.meta.dirname, '../..');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('prepared publication carries every pinned preset and refuses modified, missing, unowned and linked input', () => {
  const prepared = process.env.B15_BODY_ASSETS;
  assert.ok(prepared, 'the scoped importer stage supplies its actual prepared artifact');
  const files = bodyAssetFiles(prepared);
  const catalogue = JSON.parse(files.find((f) => f.path === 'bodies.json')!.bytes.toString('utf8'));
  assert.equal(catalogue.bodies.length, 20);
  assert.equal(catalogue.legacyDefaults.length, 4);
  assert.ok(catalogue.bodies.every((body: { legacy: unknown[] }) => body.legacy.length === 1));
  const scratch = join(repo, '.local/2750'); mkdirSync(scratch, { recursive: true });
  const tmp = mkdtempSync(join(scratch, 'plugin-test-')); cpSync(prepared, tmp, { recursive: true });
  try {
    const file = files.find((f) => f.path.endsWith('.diag'))!;
    writeFileSync(join(tmp, file.path), Buffer.concat([file.bytes, Buffer.from(' ')]));
    assert.throws(() => bodyAssetFiles(tmp), /body.assets-hash/);
    writeFileSync(join(tmp, file.path), file.bytes);
    const manifest = JSON.parse(readFileSync(join(tmp, 'body-assets.json'), 'utf8'));
    const original = structuredClone(manifest);
    manifest.files.push({ path: '../outside.json', sha256: '0'.repeat(64), bytes: 1 });
    writeFileSync(join(tmp, 'body-assets.json'), JSON.stringify(manifest));
    assert.throws(() => bodyAssetFiles(tmp), /body.assets-manifest/);
    original.sources[0].sha256 = '0'.repeat(64);
    writeFileSync(join(tmp, 'body-assets.json'), JSON.stringify(original));
    assert.throws(() => bodyAssetFiles(tmp), /body.assets-source/);
    const reset = JSON.parse(readFileSync(join(prepared, 'body-assets.json'), 'utf8'));
    writeFileSync(join(tmp, 'body-assets.json'), JSON.stringify(reset));
    rmSync(join(tmp, file.path)); symlinkSync(join(prepared, file.path), join(tmp, file.path));
    assert.throws(() => bodyAssetFiles(tmp), /body.assets-file/);
    rmSync(join(tmp, file.path)); writeFileSync(join(tmp, file.path), file.bytes);
    const short = { ...catalogue, bodies: catalogue.bodies.slice(1) };
    const bytes = Buffer.from(JSON.stringify(short)); writeFileSync(join(tmp, 'bodies.json'), bytes);
    const entry = reset.files.find((f: { path: string }) => f.path === 'bodies.json'); entry.sha256 = digest(bytes); entry.bytes = bytes.length;
    writeFileSync(join(tmp, 'body-assets.json'), JSON.stringify(reset));
    assert.throws(() => bodyAssetFiles(tmp), /body.assets-presets/);
  } finally { rmSync(tmp, { recursive: true }); }
});

test('#3998: the humanoid kit is published at its pin, every file at kit.json\'s hash, and refused otherwise', () => {
  const kitBytes = readFileSync(join(repo, 'mars/viewer/public/modular/humanoid/kit.json'));
  assert.equal(digest(kitBytes), KIT_SHA256, 'the pin is the checked-in kit.json');
  const listed = kitFiles(JSON.parse(kitBytes.toString('utf8')));
  assert.equal(listed.length, new Set(listed.map((f) => f.file)).size);
  assert.ok(listed.some((f) => f.file === 'rig-masc.glb') && listed.some((f) => f.file.startsWith('parts/')));
  const prepared = process.env.B15_BODY_ASSETS;
  if (prepared) {
    const published = bodyAssetFiles(prepared).filter((f) => f.path.startsWith('humanoid/'));
    assert.equal(published.length, listed.length + 1, 'kit.json and every file it lists');
  }
  // A synthetic kit: one rig, one part.
  const scratch = join(repo, '.local/3998'); mkdirSync(scratch, { recursive: true });
  const tmp = mkdtempSync(join(scratch, 'kit-test-'));
  try {
    assert.throws(() => humanoidKitFiles(tmp), /body.humanoid-kit-missing/);
    mkdirSync(join(tmp, 'humanoid/parts'), { recursive: true });
    const rig = Buffer.from('rig'), part = Buffer.from('part');
    const kit = Buffer.from(JSON.stringify({ frames: { masc: { rig: 'rig-masc.glb', sha256: digest(rig) } }, parts: { top: { shirt: { files: { masc: { file: 'parts/top-shirt.masc.glb', sha256: digest(part) } } } } } }));
    writeFileSync(join(tmp, 'humanoid/kit.json'), kit);
    writeFileSync(join(tmp, 'humanoid/rig-masc.glb'), rig);
    writeFileSync(join(tmp, 'humanoid/parts/top-shirt.masc.glb'), part);
    assert.throws(() => humanoidKitFiles(tmp), /body.humanoid-kit-hash/, 'a kit.json other than the pinned one');
    assert.deepEqual(humanoidKitFiles(tmp, digest(kit)).map((f) => f.path), ['humanoid/kit.json', 'humanoid/rig-masc.glb', 'humanoid/parts/top-shirt.masc.glb']);
    writeFileSync(join(tmp, 'humanoid/parts/top-shirt.masc.glb'), Buffer.from('changed'));
    assert.throws(() => humanoidKitFiles(tmp, digest(kit)), /body.humanoid-kit-hash/, 'a part not at its hash');
    rmSync(join(tmp, 'humanoid/parts/top-shirt.masc.glb')); symlinkSync(join(tmp, 'humanoid/rig-masc.glb'), join(tmp, 'humanoid/parts/top-shirt.masc.glb'));
    assert.throws(() => humanoidKitFiles(tmp, digest(kit)), /body.humanoid-kit-missing/, 'a linked part');
  } finally { rmSync(tmp, { recursive: true }); }
});

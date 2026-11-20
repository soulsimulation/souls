import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { bodyAssetFiles } from './body-assets.ts';
const repo = resolve(import.meta.dirname, '../..');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('prepared publication carries every pinned preset and refuses modified, missing, unowned and linked input', () => {
  const prepared = process.env.B15_BODY_ASSETS;
  assert.ok(prepared, 'the scoped importer stage supplies its actual prepared artifact');
  const files = bodyAssetFiles(prepared);
  const catalogue = JSON.parse(files.find((f) => f.path === 'bodies.json')!.bytes.toString('utf8'));
  assert.equal(catalogue.bodies.length, 20);
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

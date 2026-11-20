import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FLOATER_MODELS } from '../../../mars/viewer/engine/bodies/models.ts';
import { CREATURE_IDS } from '../../../mars/viewer/engine/bodies/creatures.ts';
import { bodyAssetFiles } from '../../web/body-assets.ts';
import { decodeMesh } from '../../web/src/crowd/lod.ts';
import { decodeBaked } from '../../web/src/crowd/bake.ts';
import { pinnedScan } from './presets.ts';
const repo = resolve(import.meta.dirname, '../../..');

test('all released presets have measured admitted classes, exact resources and independently hashed models', () => {
  const out = process.env.B15_BODY_ASSETS; assert.ok(out, 'actual importer output is required');
  const files = new Map(bodyAssetFiles(out).map((file) => [file.path, file.bytes]));
  const catalogue = JSON.parse(files.get('bodies.json')!.toString('utf8'));
  assert.deepEqual(catalogue.bodies.map((b: { preset: string }) => b.preset).sort(), [...FLOATER_MODELS.map((m) => m.id), 'pip', 'monster', 'ghost', 'centaur', ...CREATURE_IDS].sort());
  const radii: Record<string, number> = { small: 200, standard: 280, large: 500, giant: 1300 };
  for (const body of catalogue.bodies) {
    const entry = JSON.parse(files.get(body.entry)!.toString('utf8')), kind = files.get(body.entry.replace(/\.json$/, '.diag'))!;
    assert.equal(createHash('sha256').update(kind).digest('hex'), body.hash);
    assert.ok(body.height > 0 && body.hover >= 0 && body.size in radii);
    const radius = /4: \{1: "radius", 2: "int", 3: (\d+)/.exec(kind.toString('utf8'));
    assert.ok(radius); assert.ok(Number(radius[1]) <= radii[body.size]);
    const mesh = decodeMesh(files.get(entry.simple)!); assert.ok(mesh.index.length > 0 && mesh.index.length / 3 <= 600);
    if (entry.format === 'baked') {
      const baked = decodeBaked(files.get(entry.full)!);
      assert.equal(baked.name, 'creature:' + body.preset);
      assert.ok(baked.bones > 1 && baked.materials > 1);
      assert.ok((baked.bake.image.data as Float32Array).some((value: number, i: number, data: Float32Array) => i > 0 && value !== data[i % (baked.bones * 12)]), 'actual released transforms change over sampled time');
    }
  }
});

test('released-scan privilege is exact-source only; no changed byte or unknown model is admitted', () => {
  const media = process.env.B15_MEDIA_ROOT ?? repo;
  const source = readFileSync(join(media, 'worlds/littlemartians/characters', FLOATER_MODELS[0].file));
  assert.equal(pinnedScan(FLOATER_MODELS[0].id, source), source);
  const changed = Buffer.from(source); changed[changed.length - 1] ^= 1;
  assert.throws(() => pinnedScan(FLOATER_MODELS[0].id, changed), /body.released-source-pin/);
  assert.throws(() => pinnedScan('unknown', source), /body.released-source-pin/);
});

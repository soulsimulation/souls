import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FLOATER_MODELS } from '../../../mars/viewer/engine/bodies/models.ts';
import { CREATURE_IDS } from '../../../mars/viewer/engine/bodies/creatures.ts';
import { bodyAssetFiles } from '../../web/body-assets.ts';
import { decodeMesh } from '../../web/src/crowd/lod.ts';
import { decodeBaked } from '../../web/src/crowd/bake.ts';
import { pinnedScan, legacyBody, legacyDefaults, releasedCreature } from './presets.ts';
const repo = resolve(import.meta.dirname, '../../..');

test('all released presets have measured admitted classes, exact resources and independently hashed models', () => {
  const out = process.env.B15_BODY_ASSETS; assert.ok(out, 'actual importer output is required');
  const files = new Map(bodyAssetFiles(out).map((file) => [file.path, file.bytes]));
  const catalogue = JSON.parse(files.get('bodies.json')!.toString('utf8'));
  assert.deepEqual(catalogue.bodies.map((b: { preset: string }) => b.preset).sort(), [...FLOATER_MODELS.map((m) => m.id), 'pip', 'monster', 'ghost', 'centaur', ...CREATURE_IDS].sort());
  assert.deepEqual(catalogue.legacyDefaults, legacyDefaults);
  const radii: Record<string, number> = { small: 200, standard: 280, large: 500, giant: 1300 };
  for (const body of catalogue.bodies) {
    assert.deepEqual(body.legacy, [legacyBody(body.preset)], 'released BODY-v1 fields stay exact');
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

// The hashes of the released catalogue (soul.game, release we-5be4ec6f3). A released preset's hash never changes: a
// Soul or a world that recorded it would draw a default person or refuse to start. A changed body is a new preset.
const RELEASED: Record<string, string> = {
  'verdelis': '718b530024c85361c257b56451528c0ebd0f8723d2cbdb7b1efc9059f271608d',
  'kalama': '41995456cdad67f0e72eb768db0bff424d6296ea918ead8077937f0d1cd6486c',
  'kweku': 'f26cf64edd47af434d955db7cb3f7d8042688e780d7d3cfc0c33e034c4812eee',
  'mycos': '75a20056284a33bd49c22948fac713430ec4890c8ed1c4dfce8f7eff58a8b16b',
  'ada': 'e584723966dda5123e8889d3c1aa5e991301c83df69fdb46dc0620886a40e410',
  'shuijing': 'bb84a9da380927f20811b8c3e5930c7190ec5337e8644e67b55f7feb7f131e6e',
  'nyx': '9e36653db929149b60ebc13e43afb5972c63c198579e793f2c23fce47b68484a',
  'green-patterns-blue': '2faefa1e93a557a3e322d8bd25c9ae558aaf8615ecd4d133757f6a1b70e606df',
  'chebel': '1bd632323b0251637fe1006571b146d22e0af02b47e347e269420232e3406e35',
  'colors-lemuet': '15e6a4c0fd604c128e806e0877b8a40ccbcd74c89125c6240d7dd39c26896ef8',
  'crystal-freeman': '97671a22bf63c4f2869b01e6c7fb5005b098a947e607be482dd69041440995ba',
  'dark-blue': '0940056aa830bdbc1400b341935a244a4d6ec1bd4dccfdb84cb9378af887c470',
  'green-brains-out': '466354d8230a39479112fb3963d5eb6bf5478aa971bc43123a4599729e8f05ec',
  'pip': '7c3b2952af5330a8d8e662a3c580622caf281828b1dc6d2c78223760cff34f1f',
  'monster': '3002d89e46ed6a662374f6670173030c7347ec9b793bf90848250e22cfc06987',
  'ghost': '466f4d4825c868cfc00dbe225e3e7c1acaceb1298e6cbf0c5bd2b88e76cb6a69',
  'centaur': 'c857096d5483ce419df7c0e94ccc20a4cb5aed381f33573b6d47716c4938867c',
  'duck': '6c45476453d46d4f1c1a381c2e932c7900571cc0a901a1b29869651ab129518a',
  'snail': '036392640d9b5f4d2ea14374d59b798dfec83283a01c0b8b820b85c49749a9a7',
  'dog': 'e8da6431f615ae18c89a802f5398495e3e122e1afc2ab8a51a12c69740b30570',
};

test('every released preset keeps its released hash, on any machine', () => {
  const out = process.env.B15_BODY_ASSETS; assert.ok(out, 'actual importer output is required');
  const catalogue = JSON.parse(readFileSync(join(out, 'bodies.json'), 'utf8'));
  for (const body of catalogue.bodies) if (body.preset in RELEASED) assert.equal(body.hash, RELEASED[body.preset], `${body.preset} changed its released hash`);
  for (const preset of Object.keys(RELEASED)) assert.ok(catalogue.bodies.some((b: { preset: string }) => b.preset === preset), `${preset} is still released`);
});

test('a released creature is installed from its pinned bytes; a changed byte is refused', () => {
  const media = process.env.B15_MEDIA_ROOT ?? repo;
  for (const species of CREATURE_IDS) assert.equal(decodeBaked(releasedCreature(species, media).bake).name, 'creature:' + species);
  const copy = mkdtempSync(join(repo, '.local/released-')), at = join(copy, 'v2/tools/import-body/released');
  try {
    mkdirSync(at, { recursive: true });
    for (const name of ['dog.json', 'dog.simple.bin']) writeFileSync(join(at, name), readFileSync(join(media, 'v2/tools/import-body/released', name)));
    assert.ok(releasedCreature('dog', copy).bake.length > 0);
    const changed = readFileSync(join(at, 'dog.simple.bin')); changed[changed.length - 1] ^= 1; writeFileSync(join(at, 'dog.simple.bin'), changed);
    assert.throws(() => releasedCreature('dog', copy), /body.released-source-pin/);
    assert.throws(() => releasedCreature('unknown', copy), /body.released-source-pin/);
  } finally { rmSync(copy, { recursive: true }); }
});

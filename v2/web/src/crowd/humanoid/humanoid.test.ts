// Humanoid looks on the v2 page (#3998), with synthetic looks: the port answers as today's look module does (its def,
// read in a child process, and today-looks.json, today's answers for three synthetic looks); the look field; the shader
// patch and the crowd's carrying of it; a look drawn as a costume over the default body; the kit's hash checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import type { BakedModel } from '../bake.ts';
import { CrowdBodies } from '../bodies.ts';
import { Crowd } from '../crowd.ts';
import { crowdMaterial } from '../shader.ts';
import { HumanoidKit, infoColor, mergeParts, withGirth, withShape } from './compose.ts';
import { LOOK_FIELD, LOOK_PREFIX, bodyKey, lookOf } from './field.ts';
import { PARAMS, checkLook, lookKey, paletteOf, resolveLook } from './look.ts';
import { humanoidCompile, humanoidMaterial } from './material.ts';

const repo = resolve(import.meta.dirname, '../../../../..');
const today = JSON.parse(readFileSync(resolve(import.meta.dirname, 'today-looks.json'), 'utf8')) as { looks: { params: unknown; resolved: Record<string, unknown>; palette: number[]; pattern: number }[] };
const kit = JSON.parse(readFileSync(resolve(repo, 'mars/viewer/public/modular/humanoid/kit.json'), 'utf8'));

test("the port's params are core/humanoid@2's, field by field", () => {
  const def = resolve(repo, 'packages/world-compiler/src/core-kit/humanoid2.ts');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 'const m = await import(process.argv[1]); console.log(JSON.stringify(m.HUMANOID2_DEF.params));', pathToFileURL(def).href], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(JSON.stringify(PARAMS)), JSON.parse(out));
});

test('three synthetic looks resolve and colour as today', () => {
  assert.equal(today.looks.length, 3);
  for (const { params, resolved, palette, pattern } of today.looks) {
    const look = resolveLook(params);
    assert.deepEqual(look, resolved);
    const p = paletteOf(look, look.preset !== 'none' ? kit.presets[look.preset].palette : undefined);
    assert.equal(p.pattern, pattern);
    assert.equal(p.palette.length, palette.length);
    p.palette.forEach((v, i) => assert.ok(Math.abs(v - palette[i]) < 1e-6, `palette ${i}: ${v} vs ${palette[i]}`));
  }
  assert.equal(lookKey(resolveLook(today.looks[2].params)), lookKey(resolveLook({ ...(today.looks[2].params as object), height: 1.8200001 })), 'sizes round to one key');
});

test('a look the def refuses is refused', () => {
  for (const bad of [{ hat: 'crown' }, { height: 2 }, { skin: 'red' }, { skin: '#ABCDEF' }, { wings: 'two' }, [], null, 'casual']) assert.throws(() => checkLook(bad), Error, JSON.stringify(bad));
  assert.deepEqual(resolveLook({}).preset, 'none');
});

test('the look field: field 33 JSON params, read only as an object, and only while no body hash is worn', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(LOOK_FIELD, 33);
  assert.equal(lookOf(bytes('{"hair":"bob"}')), '{"hair":"bob"}');
  for (const bad of [bytes('[1]'), bytes('null'), bytes('{'), bytes('"x"'), new Uint8Array([0xff, 0xfe]), bytes(`{"a":"${'x'.repeat(2100)}"}`), '{"hair":"bob"}', 7, undefined]) assert.equal(lookOf(bad), undefined);
  assert.equal(bodyKey('ab'.repeat(32), '{"hair":"bob"}'), 'ab'.repeat(32), 'a worn body hash wins');
  assert.equal(bodyKey(undefined, '{"hair":"bob"}'), LOOK_PREFIX + '{"hair":"bob"}');
  assert.equal(bodyKey(undefined, undefined), undefined);
});

const standard = () => ({ uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms), vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader });

test("the palette patch reads the kit's info from the crowd's colour and keeps today's finish order", () => {
  const s = standard(), palette = new Float32Array(48), pattern = { value: 2 };
  humanoidCompile(s, palette, pattern);
  assert.equal(s.uniforms.hPalette.value, palette); assert.equal(s.uniforms.hPattern, pattern);
  assert.match(s.vertexShader, /edenHumanRole=color\.y;hSlot=color\.x;hRough=color\.z;\nvHumanP=position;/);
  const f = s.fragmentShader;
  assert.ok(f.indexOf('diffuseColor.rgb=hc;') < f.indexOf('diffuseColor.rgb*=tint;'), 'palette, then the finish tint');
  assert.ok(f.indexOf('roughnessFactor=hRough;') < f.indexOf('roughnessFactor=clamp(roughnessFactor*humanRough'), 'kit roughness, then the finish');
  assert.throws(() => humanoidCompile({ uniforms: {}, vertexShader: 'void main(){}', fragmentShader: '' }, palette, pattern), /body\.humanoid-shader-layout/);
});

test("the crowd's skinning runs after a material's own patch, under its own program key", () => {
  const uniforms = { uBake: { value: new THREE.Texture() }, uLive: { value: new THREE.Texture() }, uClipStart: { value: [] }, uClipFrames: { value: [] } };
  const plain = crowdMaterial(new THREE.MeshStandardMaterial(), uniforms);
  assert.equal(plain.customProgramCacheKey(), 'crowd', 'a plain material keeps its key');
  const look = crowdMaterial(humanoidMaterial(new Float32Array(48), 1), uniforms), s = standard();
  look.onBeforeCompile(s as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  assert.equal(look.customProgramCacheKey(), 'crowd:v2-humanoid2-v1');
  assert.match(s.vertexShader, /vec3 transformed = \(crowdSk \* vec4\(position, 1\.0\)\)\.xyz;\nedenHumanRole=color\.y/, 'skinned, then the look reads its info');
  assert.ok('hPalette' in s.uniforms && 'uBake' in s.uniforms);
});

const model = (name: string): BakedModel => ({
  name, lods: [0, 1, 2].map(() => new THREE.BoxGeometry()), bones: 2, materials: 1, triangles: [12, 12, 12], height: 1.8,
  names: ['a', 'b'], parents: Int16Array.of(-1, 0), joints: new Float32Array(6),
  bake: new THREE.DataTexture(new Float32Array(2 * 3 * 4 * 4), 6, 4, THREE.RGBAFormat, THREE.FloatType),
  clips: [{ name: 'Idle', start: 0, frames: 2, seconds: 2 }, { name: 'Walk', start: 2, frames: 2, seconds: 1 }],
});

test('a look is a costume over the default body: the default stands in while it loads or if it cannot be drawn', async () => {
  const crowd = new Crowd([model('default')], 2), bodies = new CrowdBodies(crowd), asked: string[] = [];
  let fail = false;
  crowd.worn = async (key) => { asked.push(key); if (fail) throw Error('body.humanoid-kit-unavailable'); return model('look'); };
  const key = LOOK_PREFIX + JSON.stringify(today.looks[0].params);
  bodies.begin(0); bodies.place('one', 0, 0, 0, key);
  assert.equal(crowd.ready[0], 1); assert.equal(crowd.models[crowd.model[0]].name, 'default');
  await Promise.resolve();
  bodies.begin(1); bodies.place('one', 0, 0, 0, key);
  assert.equal(crowd.models[crowd.model[0]].name, 'look'); assert.deepEqual(asked, [key]);
  fail = true; const other = LOOK_PREFIX + '{"hair":"bald"}';
  bodies.begin(2); bodies.place('two', 0, 0, 0, other); await Promise.resolve();
  bodies.begin(3); bodies.place('two', 0, 0, 0, other);
  const two = crowd.count - 1;
  assert.equal(crowd.bodyLoads.get(other)?.state, 'unavailable'); assert.equal(crowd.ready[two], 1); assert.equal(crowd.models[crowd.model[two]].name, 'default');
});

test("every kit file is checked against kit.json's hash before it is parsed", async () => {
  const manifest = new TextEncoder().encode(JSON.stringify(kit)).buffer as ArrayBuffer, sha = (b: ArrayBuffer) => createHash('sha256').update(new Uint8Array(b)).digest('hex');
  const read = async (url: string) => url.endsWith('kit.json') ? manifest : new Uint8Array([1, 2, 3]).buffer;
  await assert.rejects(new HumanoidKit('kit/', { read }).part('face', 'open', 'masc'), /body\.humanoid-kit-hash/);
  await assert.rejects(new HumanoidKit('kit/', { read }).rig('masc'), /body\.humanoid-kit-hash/);
  await assert.rejects(new HumanoidKit('kit/', { read, kitHash: '0'.repeat(64) }).manifest(), /body\.humanoid-kit-hash/);
  assert.equal((await new HumanoidKit('kit/', { read, kitHash: sha(manifest) }).manifest()).contract, 'humanoid-kit/1');
  await assert.rejects(new HumanoidKit('kit/', { read }).part('face', 'nope', 'masc'), /body\.humanoid-part/);
});

/** A kit-format triangle (position f32, normal i8n, skinIndex u8, skinWeight u8n, hinfo u8) on `bone`. */
function part(slot: number, role: number, rough: number, bone: number, x = 0): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, 1, 0, x + 0.1, 1, 0, x, 1.1, 0.1]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), 3, true));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array([bone, 0, 0, 0, bone, 0, 0, 0, bone, 0, 0, 0]), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]), 4, true));
  g.setAttribute('hinfo', new THREE.BufferAttribute(new Uint8Array([slot, role, rough, 0, slot, role, rough, 0, slot, role, rough, 0]), 4));
  g.setIndex([0, 1, 2]);
  return g;
}

test("merged parts carry each vertex's palette slot, role and roughness into the crowd's colour", () => {
  const g = infoColor(mergeParts([part(0, 1, 158, 0), part(6, 2, 224, 1, 0.5)]));
  assert.equal(g.getAttribute('position').count, 6); assert.deepEqual(Array.from(g.index!.array), [0, 1, 2, 3, 4, 5]);
  const c = g.getAttribute('color');
  assert.deepEqual([c.getX(0), c.getY(0), c.getZ(0)], [0, 1, Math.fround(158 / 255)]);
  assert.deepEqual([c.getX(5), c.getY(5), c.getZ(5)], [6, 2, Math.fround(224 / 255)]);
});

test('build and shape leave a body as it is at 1 and widen the trunk about its bone otherwise', () => {
  const rig = { names: ['Hips', 'Chest'], joints: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1.3, 0)], ends: [new THREE.Vector3(0, 1.3, 0), null] };
  const g = part(6, 2, 200, 0, 0.1), one = { shoulders: 1, chest: 1, hips: 1, weight: 1 };
  assert.equal(withGirth(g, 1, rig), g); assert.equal(withShape(g, one, rig), g);
  const wide = withGirth(g, 1.1, rig), x0 = g.getAttribute('position').getX(1), x1 = wide.getAttribute('position').getX(1);
  assert.ok(Math.abs(x1 - x0 * 1.1) < 1e-6, `trunk girth widens x about the vertical axis: ${x1}`);
  assert.ok(withShape(g, { ...one, hips: 1.1 }, rig).getAttribute('position').getX(1) > x0, 'wider hips');
});

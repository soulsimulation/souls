// A stored model (a kind made from a glTF file) is placed as today's page places it (`instantiate`): the bake's `fit`
// and `flat` on its kind reach the parts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { indexOf, partsOf } from './models.ts';

/** One triangle, 1 m on a side, as binary glTF. */
function triangle(): ArrayBuffer {
  const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.4, 0.3, 1] } }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const chunk = (b: Buffer, type: number) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, b]); };
  const body = Buffer.concat([chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  const out = Buffer.concat([head, body]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length) as ArrayBuffer;
}

test('the index carries a stored model\'s fit and flat look by its hash', () => {
  const idx = indexOf({ kinds: [{ kind: 'rug', models: { stored: 'h1' }, fit: [2, 1, 0, -1], flat: true }, { kind: 'cup', models: { k: 'h2' } }], things: { e: 'h1' } });
  assert.deepEqual(idx.fits?.get('h1'), { fit: [2, 1, 0, -1], flat: true });
  assert.equal(idx.fits?.get('h2'), undefined);
});

test('a stored model\'s parts are scaled and moved by its fit, and a flat one is drawn towards the camera', async () => {
  const [plain] = await partsOf(triangle(), [], false);
  const [fitted] = await partsOf(triangle(), [], false, '', { fit: [2, 1, 0.5, -1], flat: true });
  const at = (m: THREE.Matrix4, x: number, y: number) => new THREE.Vector3(x, y, 0).applyMatrix4(m).toArray();
  assert.deepEqual(at(plain.matrix, 1, 1), [1, 1, 0]);
  assert.deepEqual(at(fitted.matrix, 1, 1), [3, 2.5, -1]);
  assert.equal(plain.material.polygonOffset, false);
  assert.equal(fitted.material.polygonOffset, true);
  assert.notEqual(plain.key, fitted.key);
});

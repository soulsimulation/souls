// Node geometry measurement uses the same pinned Three decoder that the browser serves. Original GLBs stay exact.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const ROOT = resolve(import.meta.dirname, '../../..');
export const DECODER_PINS = {
  'draco_wasm_wrapper.js': '8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6',
  'draco_decoder.wasm': 'a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac',
};
export function decoderBytes(): Record<string, Buffer> {
  return Object.fromEntries(Object.entries(DECODER_PINS).map(([name, hash]) => {
    const bytes = readFileSync(join(ROOT, 'v2/web/node_modules/three/examples/jsm/libs/draco/gltf', name));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw Error('body.decoder-pin-mismatch');
    return [name, bytes];
  }));
}
export async function decodedGeometry(bytes: Buffer): Promise<Buffer> {
  const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  if (!json.extensionsUsed?.includes('KHR_draco_mesh_compression')) return bytes;
  const input = bytes.subarray(28 + length), chunks = [input]; let offset = input.length;
  const scratch = join(ROOT, '.local/import-body'); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'decoder-'));
  const pinned = decoderBytes(); writeFileSync(join(dir, 'decoder.cjs'), pinned['draco_wasm_wrapper.js']);
  const create = createRequire(import.meta.url)(join(dir, 'decoder.cjs'));
  let module: any;
  const add = (values: Float32Array | Uint16Array | Uint32Array, componentType: number, type: string, count: number) => {
    const padding = Buffer.alloc((4 - offset % 4) % 4); chunks.push(padding); offset += padding.length;
    const data = Buffer.from(values.buffer, values.byteOffset, values.byteLength), view = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length }); chunks.push(data); offset += data.length;
    const accessor = json.accessors.length; json.accessors.push({ bufferView: view, componentType, count, type }); return accessor;
  };
  try {
    module = await create({ wasmBinary: pinned['draco_decoder.wasm'] });
    for (const mesh of json.meshes ?? []) for (const p of mesh.primitives ?? []) {
      const draco = p.extensions?.KHR_draco_mesh_compression; if (!draco) continue;
      const view = json.bufferViews[draco.bufferView], data = input.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const buffer = new module.DecoderBuffer(), decoder = new module.Decoder(), geometry = new module.Mesh();
      buffer.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.length);
      const status = decoder.DecodeBufferToMesh(buffer, geometry);
      try {
        if (!status.ok() || !geometry.ptr) throw Error('body.draco-invalid');
        for (const [semantic, unique] of Object.entries(draco.attributes)) {
          const attribute = decoder.GetAttributeByUniqueId(geometry, unique), floats = new module.DracoFloat32Array();
          try {
            decoder.GetAttributeFloatForAllPoints(geometry, attribute, floats);
            const values = Float32Array.from({ length: floats.size() }, (_, i) => floats.GetValue(i));
            const count = geometry.num_points(), components = attribute.num_components();
            if (![1, 2, 3, 4].includes(components)) throw Error('body.draco-attribute');
            const isJoint = semantic.startsWith('JOINTS_');
            p.attributes[semantic] = add(isJoint ? Uint16Array.from(values) : values, isJoint ? 5123 : 5126, components === 1 ? 'SCALAR' : `VEC${components}`, count);
          } finally { module.destroy(floats); }
        }
        const face = new module.DracoInt32Array(), indices = new Uint32Array(geometry.num_faces() * 3);
        try { for (let i = 0; i < geometry.num_faces(); i++) { decoder.GetFaceFromMesh(geometry, i, face); for (let k = 0; k < 3; k++) indices[i * 3 + k] = face.GetValue(k); } } finally { module.destroy(face); }
        p.indices = add(indices, 5125, 'SCALAR', indices.length); delete p.extensions.KHR_draco_mesh_compression;
      } finally { module.destroy(status); module.destroy(geometry); module.destroy(decoder); module.destroy(buffer); }
    }
    for (const key of ['extensionsUsed', 'extensionsRequired']) if (json[key]) json[key] = json[key].filter((x: string) => x !== 'KHR_draco_mesh_compression');
    json.buffers = [{ byteLength: offset }]; const binary = Buffer.concat(chunks), text = Buffer.from(JSON.stringify(json));
    const textPad = Buffer.alloc((4 - text.length % 4) % 4, 32), binPad = Buffer.alloc((4 - binary.length % 4) % 4);
    const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + text.length + textPad.length + binary.length + binPad.length, 8); header.writeUInt32LE(text.length + textPad.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
    const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length + binPad.length); binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, text, textPad, binHeader, binary, binPad]);
  } finally { rmSync(dir, { recursive: true }); }
}

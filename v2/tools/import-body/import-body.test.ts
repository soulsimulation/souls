// The body importer (Engine v2 B13, #2744). A1: a body from the kit is admitted with a hash, a size class measured from
// its mesh and its resources (the ghost always; Pip when its source mesh is pulled, `pnpm assets:pull`). A3: a file
// over each limit is refused naming the field, the measured value and the limit. A4: a malformed file is refused by
// name. The kinds load in replica: `cargo test -p replica --test body_kinds`.
//   node --test v2/tools/import-body/import-body.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { authorGhost } from '../../../tools/body-authoring/ghost/author.mjs';
import { authorPip } from '../../../tools/body-authoring/robot/author.mjs';
import { decodeMesh } from '../../web/src/crowd/lod.ts';
import { importBody, Refused, SIMPLE_TRIANGLES, SIZES } from './import-body.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'import-body-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const MANIFEST = { type: 'ceramic', license: 'owned', rightsConfirmed: true, name: 'Test slab', description: 'A test body.',
  motion: { contract: 'body-motion/1', idle: { period: 3, bob: 0.01, pitch: 0, roll: 0, yaw: 0 }, move: { period: 2, bob: 0.01, pitch: 0, roll: 0, yaw: 0 }, rest: { period: 4, bob: 0, pitch: 0, roll: 0, yaw: 0 } } };

function files(name: string, glb: Buffer, manifest: object = MANIFEST): [string, string] {
  const g = join(dir, `${name}.glb`), m = join(dir, `${name}.json`);
  writeFileSync(g, glb);
  writeFileSync(m, JSON.stringify(manifest));
  return [g, m];
}

function glb(json: object, bin: Buffer): Buffer {
  const j = Buffer.from(JSON.stringify(json)), jp = Buffer.alloc(Math.ceil(j.length / 4) * 4, 32), bp = Buffer.alloc(Math.ceil(bin.length / 4) * 4);
  j.copy(jp); bin.copy(bp);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + jp.length + bp.length, 8);
  const ch = (n: number, k: number) => { const c = Buffer.alloc(8); c.writeUInt32LE(n, 0); c.writeUInt32LE(k, 4); return c; };
  return Buffer.concat([head, ch(jp.length, 0x4e4f534a), jp, ch(bp.length, 0x004e4942), bp]);
}

/** A rigid body of `tris` small triangles in a 0.5 m cube, with optional `image` bytes and `pad` extra bytes. */
function slab(tris: number, { image, pad = 0 }: { image?: Buffer; pad?: number } = {}): Buffer {
  const P = new Float32Array(tris * 9);
  for (let t = 0; t < tris; t++) {
    const x = (t % 100) / 200, y = Math.floor(t / 100) / 200;
    P.set([x, y, 0, x + 0.004, y, 0, x, y + 0.004, 0], t * 9);
  }
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) (lo[i % 3] = Math.min(lo[i % 3], P[i])), (hi[i % 3] = Math.max(hi[i % 3], P[i]));
  const parts = [Buffer.from(P.buffer)], views: object[] = [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 }];
  const json: Record<string, unknown> = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.7, 0.6, 1] } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: tris * 3, type: 'VEC3', min: lo, max: hi }] };
  let off = P.byteLength;
  if (image) {
    views.push({ buffer: 0, byteOffset: off, byteLength: image.length });
    parts.push(image, Buffer.alloc((4 - (image.length % 4)) % 4));
    off += image.length + ((4 - (image.length % 4)) % 4);
    json.images = [{ bufferView: 1, mimeType: 'image/png' }];
  }
  if (pad) parts.push(Buffer.alloc(pad));
  json.bufferViews = views;
  const bin = Buffer.concat(parts);
  json.buffers = [{ byteLength: bin.length }];
  return glb(json, bin);
}

/** A valid grey PNG of w × h. */
function png(w: number, h: number): Buffer {
  const crcT = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); t.copy(out, 4); out.writeUInt32BE(crc(t), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((w + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}

async function refusal(g: string, m: string): Promise<Refused> {
  try {
    await importBody(g, m);
  } catch (e) {
    assert.ok(e instanceof Refused, String(e));
    return e;
  }
  assert.fail('admitted');
}

function checkKind(b: Awaited<ReturnType<typeof importBody>>) {
  assert.match(b.full.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(b.simple.hash, /^sha256:[0-9a-f]{64}$/);
  const cls = SIZES.find(([, r]) => r >= b.radiusMm);
  assert.equal(b.size, cls?.[0], `a ${b.radiusMm} mm footprint takes the class at or above it`);
  assert.ok(b.heightMm > 0 && b.resources.length > 0 && b.actions.includes('go'));
  const low = decodeMesh(b.simple.bytes);
  assert.ok(low.index.length / 3 <= SIMPLE_TRIANGLES && low.index.length > 0);
  assert.match(b.text, /2: "family"/);
  assert.match(b.text, /13: \{1: \[/);
}

test('A1: the ghost from the kit is admitted: hashes, a size class measured from its mesh, its resources', async () => {
  const g = authorGhost();
  const b = await importBody(...files('ghost', g.bytes, g.manifest));
  checkKind(b);
  console.log(JSON.stringify({ kind: b.kind, size: b.size, radiusMm: b.radiusMm, heightMm: b.heightMm, hoverMm: b.hoverMm, resources: b.resources.map(([n]) => n), simple: b.simple.triangles }));
  assert.equal(b.profile, 'rigid');
  assert.deepEqual(b.resources.map(([, c]) => c), [1, 3, 4], 'no hands');
});

const PIP_SOURCE = join(REPO, 'mars/viewer/public/modular/environment/animated-casual.glb');
test('A1: Pip from the kit is admitted, measured across its clips', { skip: !existsSync(PIP_SOURCE) && 'Pip\'s source mesh is not pulled (pnpm assets:pull)' }, async () => {
  const p = authorPip({ source: PIP_SOURCE });
  const b = await importBody(...files('pip', p.bytes, p.manifest));
  checkKind(b);
  console.log(JSON.stringify({ kind: b.kind, size: b.size, radiusMm: b.radiusMm, heightMm: b.heightMm, clips: b.clips, resources: b.resources.map(([n]) => n), simple: b.simple.triangles }));
  assert.deepEqual(b.clips, ['Idle', 'Walk', 'Dance_Loop', 'Standby_Loop']);
  assert.ok(b.resources.some(([n, c, slot]) => n === 'souls:gripper-left' && c === 2 && slot === 1));
});

test('A3: a file over each limit is refused naming the field, the measured value and the limit', async () => {
  const cases: [string, Buffer, string, (n: number) => boolean, number][] = [
    ['bytes', slab(100, { pad: 4 * 1024 * 1024 }), 'bytes', (n) => n > 4 * 1024 * 1024, 4 * 1024 * 1024],
    ['triangles', slab(10_050), 'triangles', (n) => n === 10_050, 10_000],
    ['image', slab(100, { image: png(2048, 512) }), 'imageDimension', (n) => n === 2048, 1024],
  ];
  for (const [name, bytes, field, ok, limit] of cases) {
    const r = await refusal(...files(name, bytes));
    console.log(JSON.stringify({ case: name, code: r.code, field: r.field, measured: r.measured, limit: r.limit, message: r.message }));
    assert.equal(r.field, field, `${name}: ${r.code} ${r.message}`);
    assert.ok(ok(r.measured ?? NaN), `${name}: measured ${r.measured}`);
    assert.equal(r.limit, limit);
  }
});

test('A4: a malformed file is refused by name', async () => {
  const good = slab(100);
  const cases: [string, Buffer][] = [
    ['not a GLB', Buffer.from('this is not a body')],
    ['truncated', good.subarray(0, good.length - 64)],
    ['bad JSON', Buffer.concat([good.subarray(0, 20), Buffer.from('{not json'.padEnd(good.readUInt32LE(12), ' ')), good.subarray(20 + good.readUInt32LE(12))])],
  ];
  for (const [name, bytes] of cases) {
    const r = await refusal(...files(name.replace(/ /g, '-'), bytes));
    console.log(JSON.stringify({ case: name, code: r.code, message: r.message }));
    assert.match(r.code, /^(upload|body)\.[a-z-]+$/, `${name}: refused by name`);
    assert.notEqual(r.code, 'body.validator-failed');
  }
});

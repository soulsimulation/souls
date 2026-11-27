import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { encode } from '../../apps/web/node_modules/cborg/cborg.js';
import { collectPublicInputs, sealPublicInputs, verifySealedPublicInputs, sealedPublicRoute } from './sealed-public-inputs.mjs';
import { frontDoor } from '../playtest/arena/new-engine/old-page.mjs';
const sha = b => createHash('sha256').update(b).digest('hex'), head = 'a'.repeat(40);
const parent = resolve('.local/sealed-public-tests'); mkdirSync(parent, { recursive: true });
function fixture(t) {
  const root = mkdtempSync(join(parent, 'input-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), output = join(root, 'sealed'), pkg = join(root, 'pkg');
  const write = (name, bytes) => { const p = join(sourceRoot, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); };
  const multihash = bytes => Buffer.from('1220' + sha(bytes), 'hex');
  // Production T6 envelope shape with neutral test identities; native semantics are separately exercised by
  // the retained actual-input admission. Unit reader stubs below do not claim native schema validation.
  const header = encode(new Map([[1, multihash('unit build')], [2, multihash('unit schema')], [3, new Uint8Array(16)], [4, [new Uint8Array(16), 0]], [5, 0], [6, []], [7, []]]));
  const headerHash = '1220' + sha(Buffer.concat([encode('souls/header/1'), header]));
  const baseline = encode(new Map([[1, 1], [2, Buffer.from(headerHash, 'hex')], [3, new Map()]])), generation = sha(baseline);
  const stream = 'views/lineage/zone/0/node/0/everyone', prefix = stream + '/g/' + generation;
  const raw = Buffer.from('unit validated bundle'), digest = Buffer.from(sha(raw), 'hex');
  write('views/world.json', JSON.stringify({ stream: stream + '/', history: 'history/' }));
  write(stream + '/pointer', JSON.stringify({ header: headerHash, generation, baseline: generation, newest: 0 }));
  write('views/lineage/zone/0/headers/' + headerHash, header);
  write(prefix + '/baseline', baseline); write(prefix + '/baseline.text', encode([]));
  write(prefix + '/0', Buffer.from('unit part')); write(prefix + '/0.text', encode([]));
  write('history/header', header); write('history/live', JSON.stringify({ format: 'souls/history-live/1', stream: '../' + stream + '/' }));
  write('history/bundles/00000000/index', encode(new Map([[1, 1], [2, 0], [3, [[0, new TextEncoder().encode('bundles/opaque-key'), digest]]]])));
  write('history/bundles/opaque-key', deflateRawSync(raw));
  write('history/history/everyone/counts/year/0000', encode([1]));
  const assetRoot = join(root, 'assets'); mkdirSync(assetRoot); writeFileSync(join(assetRoot, 'asset'), 'unit asset');
  const assetBindings = { sourceHead: head, artifactHash: 'b'.repeat(64), trees: [{ root: assetRoot, files: { asset: sha('unit asset') } }] };
  const calls = [];
  class StreamPlayer {
    static fromBaseline() { return new StreamPlayer(); }
    play(bytes) { calls.push(['play', Buffer.from(bytes).toString()]); }
    snapshot() { return encode([]); } events() { return encode([]); } verify() { calls.push(['verify']); } free() { calls.push(['free']); }
  }
  const native = { StreamPlayer, readPointer: b => Buffer.from(b).toString(), readPart: () => calls.push(['part']), historyAt: () => { throw Error('permissive-historyAt-must-not-be-used'); }, historyTimeline: (h, b, d) => { assert.equal(sha(b), Buffer.from(d).toString('hex')); calls.push(['history']); return encode(new Map([[4, 0], [5, 1]])); } };
  mkdirSync(pkg); writeFileSync(join(pkg, 'package.json'), '{"type":"module"}');
  // Synthetic module exercises copying only; it is explicitly not native correctness/playback evidence.
  writeFileSync(join(pkg, 'replica.js'), `export const initSync=()=>{};export const readPointer=b=>new TextDecoder().decode(b);export const readPart=()=>{};export const historyTimeline=()=>new Uint8Array([162,4,0,5,1]);export class StreamPlayer{static fromBaseline(){return new StreamPlayer()}play(){}verify(){}free(){}snapshot(){return new Uint8Array([128])}events(){return new Uint8Array([128])}}`);
  writeFileSync(join(pkg, 'replica_bg.wasm'), 'synthetic binding');
  return { root, sourceRoot, output, pkg, world: 'unit-world', sourceHead: head, assetBindings, native, calls, write, stream, prefix, raw, header, headerHash, generation };
}
test('native-format header uses purpose-labelled multihash and preserves exact original namespace/bytes', t => {
  const f = fixture(t), a = collectPublicInputs(f), name = 'views/lineage/zone/0/headers/' + f.headerHash;
  assert.match(f.headerHash, /^1220[0-9a-f]{64}$/); assert.notEqual(f.headerHash.slice(4), sha(f.header));
  assert.deepEqual(a.records.get(name).bytes, Buffer.from(f.header)); assert.match(f.generation, /^[0-9a-f]{64}$/);
  const wrong = fixture(t); wrong.write('views/lineage/zone/0/headers/' + wrong.headerHash, Buffer.concat([wrong.header, Buffer.from([0])])); assert.throws(() => collectPublicInputs(wrong), /header-hash/);
  for (const bad of ['1221' + '0'.repeat(64), '0'.repeat(64)]) { const b = fixture(t), p = JSON.parse(readFileSync(join(b.sourceRoot, b.stream, 'pointer'))); p.header = bad; b.write(b.stream + '/pointer', JSON.stringify(p)); assert.throws(() => collectPublicInputs(b), /pointer/); }
});
test('complete graph follows the public pointer and opaque index digest, never sibling audiences', t => {
  const f = fixture(t); f.write('views/do-not-read/private/pointer', 'not public');
  const a = collectPublicInputs(f); assert.equal(a.manifest.stream, '/s/w/unit-world/' + f.stream + '/');
  assert.ok(![...a.records.keys()].some(n => n.includes('private'))); assert.ok(f.calls.some(c => c[0] === 'history')); assert.ok(f.calls.some(c => c[0] === 'free'));
  assert.equal(a.records.get('history/bundles/opaque-key').sha256, sha(deflateRawSync(f.raw)));
});
test('missing referenced part/text/bundle refuses rather than producing a partial seal', t => {
  for (const missing of ['part', 'text', 'bundle']) {
    const f = fixture(t), path = missing === 'part' ? f.prefix + '/0' : missing === 'text' ? f.prefix + '/baseline.text' : 'history/bundles/opaque-key';
    rmSync(join(f.sourceRoot, path)); assert.throws(() => collectPublicInputs(f), /ENOENT/);
  }
});
test('bundle digest, baseline hash and native semantic refusals propagate', t => {
  const f = fixture(t); f.write('history/bundles/opaque-key', deflateRawSync('tampered')); assert.throws(() => collectPublicInputs(f), /bundle-hash/);
  const b = fixture(t); b.write(b.prefix + '/baseline', 'tampered'); assert.throws(() => collectPublicInputs(b), /baseline-hash/);
  const n = fixture(t); n.native.StreamPlayer.fromBaseline = () => { throw Error('native-audience-refusal'); }; assert.throws(() => collectPublicInputs(n), /native-audience-refusal/);
});
test('strict timeline snapshot/carried-audience refusals propagate instead of permissive seek admission', t => {
  for (const reason of ['nonpublic legacy row', 'nonpublic carried row']) {
    const f = fixture(t); let permissive = 0;
    f.native.historyAt = () => { permissive++; return encode(new Map()); };
    f.native.historyTimeline = () => { throw Error(reason); };
    assert.throws(() => collectPublicInputs(f), new RegExp(reason)); assert.equal(permissive, 0);
  }
});
test('malformed envelope and conflicting opaque index digests refuse', t => {
  const f = fixture(t); f.write('history/bundles/00000000/index', encode(new Map([[3, []]]))); assert.throws(() => collectPublicInputs(f), /index-envelope/);
  const g = fixture(t); g.write('history/bundles/00000001/index', encode(new Map([[1, 1], [2, 1], [3, [[1, new TextEncoder().encode('bundles/opaque-key'), new Uint8Array(32)]]]]))); assert.throws(() => collectPublicInputs(g), /index-conflict/);
});
test('index escapes, symlinks and unsupported nonpublic view refuse', t => {
  const f = fixture(t); f.write('history/bundles/00000000/index', encode(new Map([[1, 1], [2, 0], [3, [[0, new TextEncoder().encode('../outside'), new Uint8Array(32)]]]]))); assert.throws(() => collectPublicInputs(f), /path/);
  const g = fixture(t); rmSync(join(g.sourceRoot, g.prefix, '0')); symlinkSync(join(g.root, 'unrelated'), join(g.sourceRoot, g.prefix, '0')); assert.throws(() => collectPublicInputs(g), /symlink/);
  const h = fixture(t); h.write('views/world.json', JSON.stringify({ stream: 'views/private/', history: 'history/' })); assert.throws(() => collectPublicInputs(h), /public-view/);
});
test('source mutation and newly published indexes refuse a moving capture', t => {
  const f = fixture(t); f.afterRead = name => { if (name === 'views/world.json') f.write(name, '{}'); }; assert.throws(() => collectPublicInputs(f), /source-changed/);
  const g = fixture(t), a = collectPublicInputs(g); g.write('history/bundles/00000001/index', encode(new Map([[1, 1], [2, 1], [3, []]]))); assert.throws(a.verifySource, /source-changed/);
});
test('file and byte admission limits fail closed, and assets bind the original source receipt', t => {
  const f = fixture(t); assert.throws(() => collectPublicInputs({ ...f, maxFiles: 2 }), /file-limit/); assert.throws(() => collectPublicInputs({ ...f, maxBytes: 1 }), /byte-limit/);
  f.assetBindings.sourceHead = 'c'.repeat(40); assert.throws(() => collectPublicInputs(f), /asset-binding/);
});
test('only exact pinned asset .vite/manifest.json is admitted; public paths and other hidden assets stay refused', t => {
  const f = fixture(t), tree = f.assetBindings.trees[0]; mkdirSync(join(tree.root, '.vite')); writeFileSync(join(tree.root, '.vite/manifest.json'), 'unit manifest'); tree.files['.vite/manifest.json'] = sha('unit manifest');
  assert.doesNotThrow(() => collectPublicInputs(f));
  writeFileSync(join(tree.root, '.vite/other'), 'other'); tree.files['.vite/other'] = sha('other'); assert.throws(() => collectPublicInputs(f), /path/);
  rmSync(join(tree.root, '.vite/other')); delete tree.files['.vite/other'];
  rmSync(join(tree.root, '.vite/manifest.json')); symlinkSync(join(tree.root, 'asset'), join(tree.root, '.vite/manifest.json')); assert.throws(() => collectPublicInputs(f), /symlink/);
  const g = fixture(t); g.write('history/bundles/00000000/index', encode(new Map([[1, 1], [2, 0], [3, [[0, new TextEncoder().encode('.vite/manifest.json'), new Uint8Array(32)]]]]))); assert.throws(() => collectPublicInputs(g), /path/);
  const h = fixture(t), assets = h.assetBindings.trees[0]; writeFileSync(join(assets.root, '.hidden'), 'hidden'); assets.files['.hidden'] = sha('hidden'); assert.throws(() => collectPublicInputs(h), /path/);
});
test('missing text reference refuses even when a text file exists', t => {
  const f = fixture(t); f.native.StreamPlayer.prototype.snapshot = () => encode([new Map([[6, new Map([[30, new Map([[21, [new Uint8Array(16), 1]]])]])]])]);
  assert.throws(() => collectPublicInputs(f), /text-reference-missing/);
});
test('copied bytes and timestamps remain independent of later source writes; sealed mutation/extra files refuse', async t => {
  const f = fixture(t), pin = await sealPublicInputs(f), m = verifySealedPublicInputs(pin);
  const copied = join(f.output, 'w/unit-world/views/world.json'), before = readFileSync(copied); f.write('views/world.json', '{}'); assert.deepEqual(readFileSync(copied), before); assert.equal(verifySealedPublicInputs(pin).stream, m.stream);
  writeFileSync(join(f.output, 'w/unit-world/views/extra'), 'not admitted'); assert.throws(() => verifySealedPublicInputs(pin), /sealed-extra-files/); rmSync(join(f.output, 'w/unit-world/views/extra'));
  chmodSync(copied, 0o644); writeFileSync(copied, '{}'); assert.throws(() => verifySealedPublicInputs(pin), /sealed-hash/);
});
test('terminal sealed route precedes mutable routing; ordinary front door remains byte-identical', t => {
  const f = fixture(t), front = 'https://soul.game {\n handle_path /s/* { reverse_proxy localhost:7320 }\n}', options = { base: 'unit-origin', launcher: 1, directory: 'unit-directory', origin: 'unit-live', web: 'unit-web', slugs: 'unit-slugs', caddyDir: 'unit-caddy' };
  const ordinary = frontDoor(front, options); assert.equal(frontDoor(front, { ...options, sealedPublic: null }), ordinary);
  const route = sealedPublicRoute({ world: f.world, root: f.output }), sealed = frontDoor(front, { ...options, sealedPublic: { world: f.world, root: f.output } });
  assert.ok(route.includes('file_server')); assert.ok(!route.includes('try_files') && !route.includes('reverse_proxy')); assert.ok(sealed.indexOf('handle @sealedPublic') < sealed.indexOf('reverse_proxy'));
  assert.throws(() => frontDoor('changed site anchor', { ...options, sealedPublic: { world: f.world, root: f.output } }), /anchor/);
});

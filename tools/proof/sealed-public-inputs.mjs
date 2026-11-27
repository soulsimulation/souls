// Fixture-only capture of authorized emitted public files. No world state is rewritten or synthesized.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Ordinary fixture/origin imports do not load an app dependency until explicit sealing/verification.
const decode = (...args) => require('../../apps/web/node_modules/cborg/cborg.js').decode(...args);
const hash = b => createHash('sha256').update(b).digest('hex');
// Native ids::Hash::of(Purpose::Header): profile text label followed by exact stored bytes, then multihash.
const headerIdentity = bytes => '1220' + createHash('sha256').update(require('../../apps/web/node_modules/cborg/cborg.js').encode('souls/header/1')).update(bytes).digest('hex');
const fail = reason => { throw Error('sealed-public-' + reason); };
const safe = p => {
  if (typeof p !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(p) || p.startsWith('/') || p.split('/').some(s => !s || s.startsWith('.') || s === '_private' || /^(credentials(?:\.json)?|deploy\.env)$/.test(s))) fail('path');
  return p;
};
function file(root, name, asset = false) {
  if (!(asset && name === '.vite/manifest.json')) safe(name); let at = resolve(root);
  if (!lstatSync(at).isDirectory() || lstatSync(at).isSymbolicLink()) fail('root');
  for (const part of name.split('/')) { at = join(at, part); if (lstatSync(at).isSymbolicLink()) fail('symlink'); }
  if (!lstatSync(at).isFile()) fail('file-kind');
  return at;
}
function names(root, prefix, max, asset = false) {
  const out = [], pending = [prefix];
  while (pending.length) {
    const at = pending.pop(), info = lstatSync(join(root, at));
    if (info.isSymbolicLink()) fail('symlink');
    if (info.isDirectory()) {
      for (const name of readdirSync(join(root, at)).sort()) {
        if (!(asset && at === '' && name === '.vite')) safe(name);
        if (out.length + pending.length >= max) fail('file-limit'); pending.push(at ? at + '/' + name : name);
      }
    } else if (info.isFile()) out.push(at); else fail('file-kind');
  }
  return out.sort();
}
function textRows(bytes) {
  const rows = decode(bytes, { useMaps: true });
  if (!Array.isArray(rows) || rows.some(r => !Array.isArray(r) || r.length !== 2 || !(r[1] instanceof Uint8Array) || !(r[0] instanceof Uint8Array || (Array.isArray(r[0]) && r[0].length === 2 && r[0][0] instanceof Uint8Array)))) fail('text');
  for (const [id, words] of rows) if (id instanceof Uint8Array && (id.length !== 32 || hash(words) !== Buffer.from(id).toString('hex'))) fail('text-hash');
  return rows;
}
const wordKey = id => id instanceof Uint8Array ? 'n:' + Buffer.from(id).toString('hex') : Buffer.from(id[0]).toString('hex') + '.' + id[1];
function requireWords(player, words) {
  const need = value => { if (value instanceof Map && value.has(21) && !words.has(wordKey(value.get(21)))) fail('text-reference-missing'); };
  for (const n of decode(player.snapshot(), { useMaps: true })) {
    const fields = n.get(6); if (!(fields instanceof Map)) continue;
    need(fields.get(30)); need(fields.get(31));
    const name = fields.get(4); if (name instanceof Uint8Array && name.length === 32 && !words.has(wordKey(name))) fail('text-reference-missing');
  }
  for (const e of decode(player.events(), { useMaps: true })) if (e.get(1) === 'souls:said') need(e.get(2)?.get(1));
}
/** Pure graph admission seam for focused tests. The sealing entry point always loads the pinned native reader. */
export function collectPublicInputs({ sourceRoot, world, sourceHead, assetBindings, native, maxFiles = 10000, maxBytes = 512 * 1024 * 1024, afterRead = () => {} }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(world) || !/^[a-f0-9]{40}$/.test(sourceHead) || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('declaration');
  const records = new Map(); let total = 0;
  const take = name => {
    safe(name); if (!/^(views|history)\//.test(name)) fail('surface');
    if (records.has(name)) return records.get(name).bytes;
    if (records.size >= maxFiles) fail('file-limit');
    const at = file(sourceRoot, name), stat = lstatSync(at);
    if (total + stat.size > maxBytes) fail('byte-limit');
    const bytes = readFileSync(at); total += bytes.length;
    records.set(name, { bytes, sha256: hash(bytes), mtimeMs: stat.mtimeMs }); afterRead(name); return bytes;
  };
  const publicView = JSON.parse(take('views/world.json'));
  const stream = safe(publicView.stream?.replace(/\/$/, ''));
  if (!stream.startsWith('views/') || !stream.endsWith('/everyone') || publicView.history !== 'history/') fail('public-view');
  const pointer = JSON.parse(native.readPointer(take(stream + '/pointer')));
  if (!/^1220[a-f0-9]{64}$/.test(pointer.header) || !(pointer.newest === null || Number.isSafeInteger(pointer.newest) && pointer.newest >= 0)) fail('pointer');
  const headerName = posix.normalize(stream + '/../../../headers/' + pointer.header);
  const header = take(headerName); if (headerIdentity(header) !== pointer.header) fail('header-hash');
  let player, prefix = stream; const words = new Set();
  const text = name => { for (const [id] of textRows(take(name))) words.add(wordKey(id)); };
  try {
    if (pointer.generation) {
      if (!/^[a-f0-9]{64}$/.test(pointer.generation) || pointer.baseline !== pointer.generation) fail('generation');
      prefix += '/g/' + pointer.generation;
      const baseline = take(prefix + '/baseline'); if (hash(baseline) !== pointer.baseline) fail('baseline-hash');
      text(prefix + '/baseline.text'); player = native.StreamPlayer.fromBaseline(header, baseline); requireWords(player, words);
    } else fail('legacy-text-coverage-unavailable');
    for (let i = 0; pointer.newest !== null && i <= pointer.newest; i++) {
      native.readPart(take(prefix + '/' + i)); text(prefix + '/' + i + '.text');
      player.play(take(prefix + '/' + i)); requireWords(player, words);
    }
    player.verify();
  } finally { player?.free(); }
  const historyHeader = take('history/header'), live = JSON.parse(take('history/live'));
  if (live.format !== 'souls/history-live/1' || typeof live.stream !== 'string' || posix.normalize('history/' + live.stream) !== stream + '/') fail('history-live');
  const indexes = names(sourceRoot, 'history/bundles', maxFiles).filter(n => /^history\/bundles\/\d{8}\/index$/.test(n));
  if (!indexes.length) fail('history-index-missing');
  const digests = new Map();
  for (const name of indexes) {
    const m = decode(take(name), { useMaps: true }), day = Number(name.split('/')[2]);
    if (!(m instanceof Map) || m.get(1) !== 1 || !['number', 'bigint'].includes(typeof m.get(2)) || Number(m.get(2)) !== day || !Array.isArray(m.get(3))) fail('index-envelope');
    let prior = -1;
    for (const row of m.get(3)) {
      if (!Array.isArray(row) || row.length !== 3 || !['number', 'bigint'].includes(typeof row[0]) || !Number.isSafeInteger(Number(row[0])) || Number(row[0]) <= prior || !(row[1] instanceof Uint8Array) || !(row[2] instanceof Uint8Array) || row[2].length !== 32) fail('index-row');
      prior = Number(row[0]); const key = safe(new TextDecoder('utf-8', { fatal: true }).decode(row[1]));
      // Public exported bundle keys are opaque, but must stay under the declared public history surface.
      const name = 'history/' + key, expected = Buffer.from(row[2]).toString('hex');
      if (digests.has(name) && digests.get(name) !== expected) fail('index-conflict'); digests.set(name, expected);
      const raw = inflateRawSync(take(name), { maxOutputLength: maxBytes }); if (hash(raw) !== expected) fail('bundle-hash');
      // Existing reader checks header, audience, sequence, chain, digest and carried public context.
      const validated = decode(native.historyTimeline(historyHeader, raw, row[2], BigInt(row[0]), BigInt(row[0])), { useMaps: true });
      if (!(validated instanceof Map) || Number(validated.get(4)) !== Number(row[0])) fail('bundle-start');
    }
  }
  // Counts/events used by the existing calendar remain exact public exports, including empty indexes.
  const publicAuxiliary = names(sourceRoot, 'history/history/everyone', maxFiles);
  for (const name of publicAuxiliary) take(name);
  const assets = verifyAssets(assetBindings, sourceHead);
  const verifySource = () => {
    for (const [name, r] of records) if (hash(readFileSync(file(sourceRoot, name))) !== r.sha256 || lstatSync(file(sourceRoot, name)).mtimeMs !== r.mtimeMs) fail('source-changed');
    // A new/removed index changes reference completeness even when old files stayed unchanged.
    if (JSON.stringify(names(sourceRoot, 'history/bundles', maxFiles).filter(n => /^history\/bundles\/\d{8}\/index$/.test(n))) !== JSON.stringify(indexes)) fail('source-changed');
    if (JSON.stringify(names(sourceRoot, 'history/history/everyone', maxFiles)) !== JSON.stringify(publicAuxiliary)) fail('source-changed');
    verifyAssets(assetBindings, sourceHead);
  };
  verifySource();
  return { records, verifySource, manifest: { schema: 'sealed-public-inputs/1', sourceHead, world, stream: '/s/w/' + world + '/' + stream + '/', history: '/s/w/' + world + '/history/', limits: { maxFiles, maxBytes }, assets,
    files: Object.fromEntries([...records].map(([name, r]) => ['w/' + world + '/' + name, { sha256: r.sha256, bytes: r.bytes.length, mtimeMs: r.mtimeMs }])) } };
}
function verifyAssets(bindings, sourceHead) {
  if (!bindings || bindings.sourceHead !== sourceHead || !/^[a-f0-9]{64}$/.test(bindings.artifactHash) || !Array.isArray(bindings.trees) || !bindings.trees.length) fail('asset-binding');
  for (const tree of bindings.trees) {
    if (!isAbsolute(tree.root) || !tree.files || !Object.keys(tree.files).length) fail('asset-binding');
    if (JSON.stringify(names(tree.root, '', 100000, true)) !== JSON.stringify(Object.keys(tree.files).sort())) fail('asset-files');
    for (const [name, expected] of Object.entries(tree.files)) if (hash(readFileSync(file(tree.root, name, true))) !== expected) fail('asset-hash');
  }
  return bindings;
}
export async function sealPublicInputs(options) {
  const { pkg, output } = options;
  const js = readFileSync(file(pkg, 'replica.js')), wasm = readFileSync(file(pkg, 'replica_bg.wasm'));
  const native = await import(pathToFileURL(file(pkg, 'replica.js')).href); native.initSync({ module: wasm });
  const admission = collectPublicInputs({ ...options, native });
  mkdirSync(output, { recursive: false });
  for (const [name, r] of admission.records) {
    const target = join(output, 'w', options.world, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, r.bytes, { flag: 'wx', mode: 0o444 }); utimesSync(target, r.mtimeMs / 1000, r.mtimeMs / 1000);
  }
  admission.verifySource();
  const manifest = { ...admission.manifest, validator: { js: hash(js), wasm: hash(wasm) } };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); writeFileSync(join(output, 'manifest.json'), bytes, { flag: 'wx', mode: 0o444 });
  const pin = { root: resolve(output), sha256: hash(bytes) }; verifySealedPublicInputs(pin); return pin;
}
export function verifySealedPublicInputs(pin) {
  const root = resolve(pin.root), bytes = readFileSync(file(root, 'manifest.json')); if (hash(bytes) !== pin.sha256) fail('manifest-hash');
  const m = JSON.parse(bytes); if (m.schema !== 'sealed-public-inputs/1' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(m.world) || !m.files || !Object.keys(m.files).length) fail('manifest');
  for (const [name, r] of Object.entries(m.files)) {
    if (!name.startsWith('w/' + m.world + '/views/') && !name.startsWith('w/' + m.world + '/history/')) fail('surface');
    const b = readFileSync(file(root, name)); if (b.length !== r.bytes || hash(b) !== r.sha256) fail('sealed-hash');
  }
  const view = JSON.parse(readFileSync(file(root, 'w/' + m.world + '/views/world.json')));
  if (m.stream !== '/s/w/' + m.world + '/' + view.stream || m.history !== '/s/w/' + m.world + '/history/' || view.history !== 'history/') fail('manifest-routes');
  if (JSON.stringify(names(root, 'w', m.limits.maxFiles + 1)) !== JSON.stringify(Object.keys(m.files).sort())) fail('sealed-extra-files');
  verifyAssets(m.assets, m.sourceHead);
  return { ...m, root };
}
/** Terminal route: a missing sealed file returns404 here, never falls through to the live origin. */
export function sealedPublicRoute(sealed) {
  if (!sealed) return '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sealed.world) || !isAbsolute(sealed.root)) fail('route');
  // Inserted inside the existing handle_path /s/*, after its normal prefix stripping.
  return `\n\t@sealedPublic path /w/${sealed.world}/views /w/${sealed.world}/views/* /w/${sealed.world}/history /w/${sealed.world}/history/*\n\thandle @sealedPublic {\n\t\troot * ${JSON.stringify(sealed.root)}\n\t\theader Cache-Control "public, max-age=31536000, immutable, no-transform"\n\t\tfile_server\n\t}\n`;
}

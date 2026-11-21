// Engine v2 V17 (#2717): Eden's kinds drawn once, at import, and kept as models named by their hash.
//
// Replays the committed template as export/export.ts does, then runs today's mesh builders (apps/web/src/gen-mesh,
// called as a tool and unchanged) in Node behind three small shims, once per kind and set of geometry parameters
// (the builder's own instance key), and writes each picture as binary glTF named by its T3 hash:
// `souls/model/1`, then the bytes, SHA-256, written `1220` and 64 hex digits. Files are only added.
//
//   node v2/tools/import-eden/bake/bake.ts [--seed <s>] [--out <dir>] [--template <file>] [--write-records]
//   (from the repository root, after `pnpm install`)
//
// Writes, under <out> (default .local/import-eden/models): `worlds/models/<hash>.glb` (the tree that
// `tools/cdn/publish.mjs --dry-run --root <out>` inventories) and `models.json` (every kind: its model or the reason it
// has none, its state table, and a model per geometry key; the summary; the state check). Generated; never committed.
// --write-records adds this run's models to the licence records in tools/cdn/approved-derivatives.json (`generated`).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorldModel, applyBatch, coreLibrary, correctKitDefines, type Entity } from '../../../../packages/world-compiler/src/index.ts';
import { GENERATORS } from '../../../../packages/generators/src/index.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : d; };
const SEED = arg('--seed', 'eden-local-lifecycle:genesis');
const OUT = arg('--out', '.local/import-eden/models');
const TEMPLATE = arg('--template', 'worlds/templates/eden-2026.json');
const WEB = 'apps/web/src/gen-mesh';

// --- Shims: three's exporter reads blobs through FileReader; builders that draw text need a canvas (none here) -------
const g0 = globalThis as Record<string, unknown>;
g0.self ??= globalThis;
g0.location ??= { pathname: '/', search: '', hash: '', href: '', origin: '', hostname: '' }; // read at import by world-path.ts
g0.FileReader ??= class {
  result: unknown = null; onloadend?: () => void;
  readAsArrayBuffer(b: Blob) { b.arrayBuffer().then((a) => { this.result = a; this.onloadend?.(); }); }
  readAsDataURL(b: Blob) { b.arrayBuffer().then((a) => { this.result = `data:${b.type || 'application/octet-stream'};base64,` + Buffer.from(a).toString('base64'); this.onloadend?.(); }); }
};

// one `three` for the builders and the exporter: the web app's own
const THREE = await import(pathToFileURL(join(process.cwd(), 'apps/web/node_modules/three/build/three.module.js')).href) as typeof import('three');
const { GLTFExporter } = await import(pathToFileURL(join(process.cwd(), 'apps/web/node_modules/three/examples/jsm/exporters/GLTFExporter.js')).href);
const { meshFor } = await import(pathToFileURL(join(process.cwd(), WEB, 'registry.ts')).href) as typeof import('../../../../apps/web/src/gen-mesh/registry.ts');
const { buildKit, isPlantDef } = await import(pathToFileURL(join(process.cwd(), WEB, 'kit.mesh.ts')).href) as typeof import('../../../../apps/web/src/gen-mesh/kit.mesh.ts');
const { flameHint } = await import(pathToFileURL(join(process.cwd(), 'apps/web/src/fx/flames.ts')).href) as typeof import('../../../../apps/web/src/fx/flames.ts');
const { MaterialLib } = await import(pathToFileURL(join(process.cwd(), WEB, 'materials.ts')).href) as typeof import('../../../../apps/web/src/gen-mesh/materials.ts');
// Vite registers builders by `import.meta.glob('./**/*.mesh.ts')`; here they are imported by name, in that order
const meshFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? meshFiles(join(dir, e.name)) : e.name.endsWith('.mesh.ts') ? [join(dir, e.name)] : []).sort();
const loadErrors: Record<string, string> = {};
for (const f of meshFiles(WEB)) { try { await import(pathToFileURL(join(process.cwd(), f)).href); } catch (e) { loadErrors[relative(WEB, f)] = String(e).slice(0, 200); } }

// --- Replay (as export/export.ts) ------------------------------------------------------------------------------------
const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
// A template's mesh things name core assets by hash (the Mars campus does); resolve them as the server does (export.ts).
const { coreAssets } = await import('../../import-world/export/backup.ts');
const core = coreAssets();
const m = new WorldModel({ constants: { ground: 'land', extent: 1000, ...tpl.constants }, seed: SEED, assets: (sha) => core[sha] });
m.library = coreLibrary();
let tick = 1;
const apply = (batch: unknown, what: string) => { const r = applyBatch(m, batch, 'genesis', tick++, { trusted: true }); if (!r.result.accepted) throw new Error(`${what} refused: ${JSON.stringify(r.result).slice(0, 600)}`); };
if (tpl.state) apply({ ops: [{ op: 'world', state: tpl.state }], group: 'genesis' }, 'state');
for (const [i, b] of tpl.batches.entries()) apply(correctKitDefines({ ops: b.ops, group: b.group ?? 'genesis' }).batch, `batch ${i + 1}`);

// --- Hash (T3, v2/docs/ids.md rules 9-10): label as one CBOR text item, then the stored bytes ----------------------
const LABEL = 'souls/model/1';
function cborText(s: string) { const b = Buffer.from(s, 'utf8'); if (b.length >= 256) throw Error('label too long'); return Buffer.concat([Buffer.from(b.length < 24 ? [0x60 + b.length] : [0x78, b.length]), b]); }
const modelHash = (bytes: Buffer) => '1220' + createHash('sha256').update(cborText(LABEL)).update(bytes).digest('hex');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// --- Builders, once per key ------------------------------------------------------------------------------------------
type StoredDef = NonNullable<ReturnType<typeof m.resolvedDef>>;
const lib = new MaterialLib();
function ctxOf(e: Entity, def: StoredDef, state?: Record<string, unknown>) {
  const gen = def.make.kind === 'gen' ? (GENERATORS as Record<string, { params?: Record<string, unknown> }>)[def.make.gen] : undefined;
  const params: Record<string, unknown> = {};
  for (const [k, f] of Object.entries({ ...(gen?.params ?? {}), ...def.params })) if ((f as { default?: unknown }).default !== undefined) params[k] = (f as { default: unknown }).default;
  Object.assign(params, e.params ?? {});
  const entity = state ? { ...e, state } : e;
  return {
    def, entity, params, args: def.make.kind === 'gen' ? ((def.make.args ?? {}) as Record<string, unknown>) : {},
    baked: m.bake(def, e.params ?? {}, e.seed ?? 0, e.shape), model: m, materials: lib,
    tint: (key: string | undefined, fallback: string) => { if (!key) return fallback; const v = params[key]; return typeof v === 'string' && /^#/.test(v) ? v : (def.palette as Record<string, string> | undefined)?.[key] ?? fallback; },
  } as never;
}
/** What the builder draws, as numbers: tint, variation and stretch stay on the instance, so they leave the key. */
const ON_INSTANCE = new Set(['tint', 'vary', 'sx', 'sy', 'sz']);
/** Geometry key: the builder's instance key with the look's per-instance numbers taken out; null is "one per thing". */
function keyOf(builder: NonNullable<ReturnType<typeof meshFor>>, e: Entity, def: StoredDef): string | null {
  // the key is taken as if the thing had no instance look (stretch, tint) and its state at default: those are numbers on the instance
  const plain: Entity = { ...e, params: Object.fromEntries(Object.entries(e.params ?? {}).filter(([k]) => !ON_INSTANCE.has(k))), state: undefined } as Entity;
  const k = builder.instanceKey?.(ctxOf(plain, def, undefined));
  return typeof k === 'string' ? k : null;
}
/** The state looks the page applies to a model's named parts (apps/web/src/gen-mesh/vocab-look.ts `stateRoles`). */
const STATE_ROLES: Record<string, string[]> = {
  open: ['door', 'lid', 'curtain-l', 'curtain-r', 'blind', 'flip', 'canopy', 'drawer'], locked: ['bolt', 'thumb', 'key'], lit: ['flame'],
  on: ['light', 'screen'], level: ['fill'], moisture: ['fill', 'head'], station: ['needle', 'knob'],
};
/** Field -> the model's parts it changes: role parts, `when:` parts, and the kind's looks table (SA-D1a). */
function stateTable(def: StoredDef, parts: string[]): Record<string, string[]> {
  const fields = Object.keys(def.state ?? {}), out: Record<string, string[]> = {};
  const add = (f: string, part: string) => { if (fields.includes(f) && parts.includes(part)) (out[f] ??= []).includes(part) || out[f].push(part); };
  for (const [f, roles] of Object.entries(STATE_ROLES)) for (const r of roles) add(f, r);
  for (const p of parts) if (p.startsWith('when:')) for (const f of p.slice(5).match(/@([A-Za-z][\w-]*)/g) ?? []) add(f.slice(1), p);
  const table = (def.make.kind === 'gen' ? (def.make.args as { looks_table?: { field: string; part?: string }[] })?.looks_table : undefined) ?? [];
  for (const r of table) if (r.part) add(r.field, r.part);
  if (fields.includes('on') && !out.on) out.on = ['(glow materials)'];
  if (fields.includes('paint')) out.paint = ['(tint on the instance)'];
  for (const f of ['text', 'media', 'title', 'maker']) if (fields.includes(f)) out[f] = ['(face drawn on the instance)'];
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
type Shape = { when?: string };
/** A kit with parts shown only in some state (`when: "@on"`): every such part is drawn into the one model as a group named
 *  `when:<condition>`, so a change of state shows or hides a part and never needs another model. */
function conditionalKit(def: StoredDef, e: Entity): import('three').Object3D | null {
  if (def.make.kind !== 'gen' || def.make.gen !== 'kit/2') return null;
  const args = def.make.args as { shapes?: Shape[] };
  if (!args?.shapes?.some((x) => x.when?.includes('@'))) return null;
  const c = ctxOf(e, def, undefined) as unknown as { params: Record<string, unknown>; materials: InstanceType<typeof MaterialLib>; tint: (k: string | undefined, f: string) => string };
  const opts = { materials: c.materials, tint: c.tint, params: c.params, state: {}, flameHint: flameHint(def as never), plant: isPlantDef(def as never), smokeFx: false };
  const plain = (w?: string) => !w || !w.includes('@');
  const strip = (w: string) => w.split('&').map((t) => t.trim()).filter((t) => !t.replace(/^!/, '').trim().startsWith('@')).join('&') || undefined;
  const root = buildKit({ ...args, shapes: args.shapes.filter((x) => plain(x.when)) }, opts as never);
  for (const cond of [...new Set(args.shapes.filter((x) => !plain(x.when)).map((x) => x.when!))].sort()) {
    const g = buildKit({ ...args, shapes: args.shapes.filter((x) => x.when === cond).map((x) => ({ ...x, when: strip(cond) })) }, opts as never);
    g.name = `when:${cond}`; g.userData = { role: `when:${cond}`, when: cond };
    root.add(g);
  }
  return root;
}
const GROUND_AND_WATER = new Set(['lake/1', 'landform/1', 'river/1', 'shore/1']);
async function exportGlb(obj: import('three').Object3D): Promise<Buffer> {
  // Runtime effects (fire seeded by the thing's id, falling water, shadow proxies: three ShaderMaterials) are the page's,
  // not the model's; the flame clusters they are mounted from stay as data on their part.
  const effects: import('three').Object3D[] = [];
  obj.traverse((o) => { if ([(o as import('three').Mesh).material].flat().some((x) => (x as { isShaderMaterial?: boolean } | undefined)?.isShaderMaterial)) effects.push(o); });
  for (const o of effects) o.removeFromParent();
  // Only a part's name (for the state table) and its flame clusters go in the file: the page's runtime userData (rigs,
  // world refs) and three's random uuids would make the bytes differ between runs.
  // Materials and geometries are shared with later builds (the builders' caches): their userData is set aside for the
  // export and put back.
  const shared = new Map<{ userData: Record<string, unknown> }, Record<string, unknown>>();
  obj.traverse((o) => {
    const { role, when, flames } = o.userData; o.userData = { ...(typeof role === 'string' ? { role } : {}), ...(typeof when === 'string' ? { when } : {}), ...(Array.isArray(flames) ? { flames: JSON.parse(JSON.stringify(flames)) } : {}) };
    const mats = (o as import('three').Mesh).material, geo = (o as import('three').Mesh).geometry;
    for (const x of [...(mats ? [mats].flat() : []), ...(geo ? [geo] : [])]) if (!shared.has(x)) { shared.set(x, x.userData); x.userData = {}; }
  });
  const scene = new THREE.Scene(); scene.add(obj); scene.updateMatrixWorld(true);
  try {
    const ab = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false, includeCustomExtensions: false });
    return Buffer.from(ab as ArrayBuffer);
  } finally { for (const [x, u] of shared) x.userData = u; }
}
function stats(o: import('three').Object3D) {
  let tris = 0, parts = 0, effects = 0; const named = new Set<string>();
  o.traverse((c) => { const mm = c as import('three').Mesh; if (typeof c.userData.role === 'string') named.add(c.userData.role); if (!mm.isMesh) return; parts++;
    if ([mm.material].flat().some((x) => (x as { isShaderMaterial?: boolean })?.isShaderMaterial)) effects++; const geo = mm.geometry; const n = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3; tris += n * ((mm as unknown as { count?: number }).count ?? 1); });
  return { tris: Math.round(tris), parts, effects, roles: [...named].sort() };
}

// --- Stored meshes --------------------------------------------------------------------------------------------------
// A kind made from a stored glTF file (`make: {kind:'mesh', asset}`) is drawn from that file's bytes as today's page gets
// them: the viewer's rendition when there is one (worlds/core-assets/renditions.json, served under the source's hash at
// /asset-view), else the file itself. The bytes go in unchanged (meshopt, WebP), named by their T3 hash like any model.
// Today's page fits the model to the def's box (apps/web/src/gen-mesh/gltf-assets.ts `instantiate`): its bounds centred
// on x and z, standing on y = 0, uniformly scaled so its largest extent matches the box on that axis. The bake does the
// same from the measured bounds in the core index (`min`, `box`) and writes it on the kind as `fit`
// ([scale, x, y, z]: the model's point p is drawn at scale * p + (x, y, z), metres). A model a few centimetres thick (a
// rug, a lily pad) is drawn a hair towards the camera, as today: `flat`.
const renditions = (JSON.parse(readFileSync('worlds/core-assets/renditions.json', 'utf8')) as { renditions: Record<string, { path: string }> }).renditions;
function storedModel(row: KindRow, def: StoredDef): string {
  const sha = row.stored!, info = core[sha] as (typeof core)[string] & { path?: string; min?: number[] } | undefined;
  const file = renditions[sha]?.path && existsSync(renditions[sha].path) ? renditions[sha].path : info?.path;
  if (!info || !file || !existsSync(file) || !info.min) { row.reason = `stored mesh ${sha.slice(0, 12)}: ${!info ? 'not a core asset' : !info.min ? 'no measured bounds' : 'file missing (pnpm assets:pull)'}`; return ''; }
  const bytes = readFileSync(file), hash = modelHash(bytes);
  const out = join(OUT, 'worlds/models', `${hash}.glb`);
  if (!existsSync(out)) writeFileSync(out, bytes, { flag: 'wx' });
  const size = info.box as number[], min = info.min, box = def.size.box as number[];
  const a = size.indexOf(Math.max(...size)), k = size[a] > 1e-6 ? box[a] / size[a] : 1;
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  row.fit = [r6(k), r6(-k * (min[0] + size[0] / 2)), r6(-k * min[1]), r6(-k * (min[2] + size[2] / 2))];
  if (box[1] <= 0.06) row.flat = true;
  row.models.stored = hash; row.model = hash; built++;
  models.set(hash, { hash, bytes: bytes.length, tris: info.tris ?? 0, parts: 0, effects: 0, roles: [], kind: def.ref, key: 'stored', sha256: sha256(bytes), source: sha });
  return hash;
}

type KindRow = { kind: string; ref: string; hash: string; things: number; builder: string | null; models: Record<string, string>; model?: string; reason?: string; stored?: string; states?: Record<string, string[]>; worldThings?: number; failed?: Record<string, string>; fit?: number[]; flat?: true };
const kinds = new Map<string, KindRow>();
const models = new Map<string, { hash: string; bytes: number; tris: number; parts: number; effects: number; roles: string[]; kind: string; key: string; sha256: string; source?: string }>();
const keyed = new Map<string, string>(); // kind ref + key -> model hash
const thingModels: Record<string, string> = {}; // today's thing id -> its model's hash (V8 #2718: the page's table)
mkdirSync(join(OUT, 'worlds/models'), { recursive: true });
let built = 0;
for (const e of [...m.entities.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  const def = m.resolvedDef(e.def); if (!def) continue;
  let row = kinds.get(def.ref);
  if (!row) { row = { kind: def.name, ref: def.ref, hash: def.hash, things: 0, builder: null, models: {} }; kinds.set(def.ref, row); }
  row.things++;
  if (row.reason) continue;
  if (def.make.kind === 'none' || def.make.kind === 'parts') { row.reason = `no picture of its own (make: ${def.make.kind})`; continue; }
  if (def.make.kind === 'mesh') {
    row.builder = 'mesh'; row.stored = (def.make as { asset: string }).asset;
    const hash = keyed.get(def.ref) ?? storedModel(row, def);
    keyed.set(def.ref, hash);
    if (hash) thingModels[e.id] = hash;
    continue;
  }
  const builder = meshFor(def as never);
  if (!builder) { row.reason = 'no mesh builder for its generator'; continue; }
  row.builder = builder.gen;
  if (GROUND_AND_WATER.has(builder.gen)) { row.reason = `ground and water (${builder.gen}): not in this task`; continue; }
  if (builder.world) { row.worldThings = (row.worldThings ?? 0) + 1; continue; }
  const key = keyOf(builder, e, def) ?? `thing:${e.id}`;
  const k = def.ref + '\u0000' + key;
  if (keyed.has(k)) { if (keyed.get(k)) thingModels[e.id] = keyed.get(k)!; continue; }
  try {
    const plainThing = { ...e, params: Object.fromEntries(Object.entries(e.params ?? {}).filter(([p]) => !ON_INSTANCE.has(p))) } as Entity;
    const obj = conditionalKit(def, plainThing) ?? builder.build(ctxOf(plainThing, def, undefined));
    if (!obj) { row.failed ??= {}; row.failed[key] = 'builder drew nothing'; keyed.set(k, ''); continue; }
    const effectParts = stats(obj).effects;
    const bytes = await exportGlb(obj), s = { ...stats(obj), effects: effectParts };
    const hash = modelHash(bytes);
    const file = join(OUT, 'worlds/models', `${hash}.glb`);
    if (!existsSync(file)) writeFileSync(file, bytes, { flag: 'wx' });
    models.set(hash, { hash, bytes: bytes.length, ...s, kind: def.ref, key, sha256: sha256(bytes) });
    keyed.set(k, hash); row.models[key] = hash; thingModels[e.id] = hash; built++;
    const st = stateTable(def, s.roles); if (Object.keys(st).length) row.states = st; else delete row.states;
  } catch (err) { row.failed ??= {}; row.failed[key] = String(err).slice(0, 160); keyed.set(k, ''); }
}
for (const r of kinds.values()) {
  const n = Object.keys(r.models).length;
  if (r.reason || r.stored) continue;
  if (n === 1) r.model = Object.values(r.models)[0];
  if (n === 0 && r.worldThings) r.reason = `drapes on the ground (${r.builder}): one shape per thing, not per kind`;
  else if (n === 0 && r.failed) r.reason = `builder failed in Node: ${Object.values(r.failed)[0]}`;
}
// A3, state: the old builder's key under every value of every declared state field. A kind whose key moves with state
// would have needed another picture; each must be covered by `when:` parts in its one model.
type FieldSpec = { type?: string; values?: unknown[]; default?: unknown; min?: number; max?: number };
const valuesOf = (f: FieldSpec): unknown[] => f.type === 'bool' ? [false, true] : f.type === 'enum' && f.values ? f.values : f.type === 'number' || typeof f.default === 'number' ? [f.min ?? 0, f.default ?? 0.5, f.max ?? 1] : [f.default];
const stateCheck = { kindsWithState: 0, statesTried: 0, posedOnInstance: {} as Record<string, string[]>, notDrawn: {} as Record<string, string[]>, geometryMoves: [] as string[], coveredByParts: [] as string[], uncovered: [] as string[] };
const firstThing = new Map<string, Entity>();
for (const e of m.entities.values()) { const d = m.resolvedDef(e.def); if (d && !firstThing.has(d.ref)) firstThing.set(d.ref, e); }
for (const r of kinds.values()) {
  if (!Object.keys(r.models).length || r.stored) continue;
  const def = m.resolvedDef(firstThing.get(r.ref)!.def)!, fields = Object.entries((def.state ?? {}) as Record<string, FieldSpec>);
  if (!fields.length) continue;
  stateCheck.kindsWithState++;
  const builder = meshFor(def as never)!, e = firstThing.get(r.ref)!, keys = new Set<string>(), posed = new Set<string>();
  // a null key is the page's look wrapper declining to instance a thing whose state poses its parts (vocab-look.ts):
  // the same model, posed on the instance; only a different non-null key is a different picture
  const keyed = typeof builder.instanceKey?.(ctxOf(e, def, undefined)) === 'string';
  for (const [f, spec] of fields) for (const v of valuesOf(spec)) { stateCheck.statesTried++; const k = builder.instanceKey?.(ctxOf(e, def, { [f]: v })); if (typeof k === 'string') keys.add(k); else if (keyed) posed.add(f); }
  if (posed.size) stateCheck.posedOnInstance[r.ref] = [...posed].sort();
  // a posed field the table does not name changes nothing this kind draws (a lock with no bolt part)
  const notDrawn = [...posed].filter((f) => !r.states?.[f]); if (notDrawn.length) stateCheck.notDrawn[r.ref] = notDrawn;
  if (keys.size < 2) continue;
  stateCheck.geometryMoves.push(r.ref);
  (Object.keys(r.states ?? {}).some((f) => r.states![f].some((p) => p.startsWith('when:'))) ? stateCheck.coveredByParts : stateCheck.uncovered).push(r.ref);
}
const rows = [...kinds.values()].sort((a, b) => a.ref.localeCompare(b.ref));
const summary = {
  template: TEMPLATE, templateSha256: sha256(readFileSync(TEMPLATE)), label: LABEL, things: m.entities.size,
  kinds: rows.length, kindsWithModel: rows.filter((r) => Object.keys(r.models).length).length,
  kindsStored: rows.filter((r) => r.stored).length, kindsListed: rows.filter((r) => r.reason).length,
  models: models.size, modelBytes: [...models.values()].reduce((n, x) => n + x.bytes, 0), triangles: [...models.values()].reduce((n, x) => n + x.tris, 0),
  builderLoadErrors: loadErrors, stateCheck,
};
// A kind drawn from a stored model already has its picture: its licence record is the reviewed derivative or served-public file.
const reviewedPath = 'tools/cdn/approved-derivatives.json';
const reviewed = JSON.parse(readFileSync(reviewedPath, 'utf8')) as { derivatives: { sha256: string; licence: string }[]; generated?: { by: string; licence: string; note: string; models: { path: string; sha256: string; bytes: number; licence: string; kind: string }[] } };
const servedPublic = JSON.parse(readFileSync('tools/cdn/served-public.json', 'utf8')) as { objects: { sha256: string }[] };
// Its model file is those bytes (or the rendition's), checked by their own SHA-256 as the CDN inventory checks them.
const recordOf = (sha: string) => reviewed.derivatives.some((d) => d.sha256 === sha && d.licence === 'CC0-1.0') ? 'approved-derivatives (CC0-1.0)' : servedPublic.objects.some((o) => o.sha256 === sha) ? 'served-public' : 'none';
for (const r of rows) if (r.stored) Object.assign(r, { storedRecord: recordOf(r.stored), ...(r.model ? { modelRecord: recordOf(models.get(r.model)!.sha256) } : {}) });
const records = [...models.values()].filter((x) => !x.source).sort((a, b) => a.hash.localeCompare(b.hash)).map((x) => ({ path: `models/${x.hash}.glb`, sha256: x.sha256, bytes: x.bytes, licence: 'own-work', kind: x.kind }));
// --write-records: add this run's models to tools/cdn/approved-derivatives.json `generated` (records are only added)
if (process.argv.includes('--write-records')) {
  const g = reviewed.generated ??= { by: 'v2/tools/import-eden/bake/bake.ts', licence: 'own-work', note: 'Engine v2 V17 (#2717): models drawn by this repository\'s own mesh builders (apps/web/src/gen-mesh) from the kinds of committed world templates, with no image or third-party bytes in them. Each is pinned by its SHA-256 and bytes; its file is named by its T3 hash (souls/model/1). Records are only added.', models: [] };
  const have = new Set(g.models.map((x) => x.sha256));
  for (const r of records) if (!have.has(r.sha256)) g.models.push(r);
  g.models.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(reviewedPath, JSON.stringify(reviewed, null, 2) + '\n');
}
writeFileSync(join(OUT, 'models.json'), JSON.stringify({ summary, kinds: rows, models: [...models.values()].sort((a, b) => a.hash.localeCompare(b.hash)), things: thingModels }, null, 1) + '\n');
console.log(JSON.stringify({ ...summary, built }, null, 1));

// The operator binds the old registry identity to one canonical v2 route. The canonical flag is the only switch.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { worldIdOf } from './registry.mjs';
import { scriptJson } from './page-meta.mjs';

const files = new Set(['/v1/config', '/eden.mjs', '/skill.md', '/creator.md', '/instructions.md', '/llms.txt', '/replica.js', '/replica_bg.wasm']);
const types = { 'eden.mjs': 'text/javascript; charset=utf-8', 'replica.js': 'text/javascript; charset=utf-8', 'replica_bg.wasm': 'application/wasm',
  'skill.md': 'text/markdown; charset=utf-8', 'creator.md': 'text/markdown; charset=utf-8', 'instructions.md': 'text/markdown; charset=utf-8' };
// Installed artifacts and operator activation are data. The old runtime never imports or evaluates v2 code.
function readBounded(file, maximum) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw Error('cutover.data-invalid');
    const bytes = Buffer.alloc(stat.size);
    for (let at = 0; at < bytes.length;) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (!n) throw Error('cutover.data-changed');
      at += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length)) throw Error('cutover.data-changed');
    return bytes;
  } finally { closeSync(fd); }
}
function answer(dir, path) {
  if (!files.has(path)) return null;
  try {
    if (path === '/v1/config') {
      const soulClient = JSON.parse(readBounded(join(dir, 'soul-client.json'), 64 * 1024));
      return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify({ soulClient })) };
    }
    const name = path === '/llms.txt' ? 'instructions.md' : path.slice(1);
    return { status: 200, type: types[name], body: readBounded(join(dir, name), 32 * 1024 * 1024) };
  } catch { return null; }
}
// The same public stream path the v2 origin's routes accept (v2/tools/origin/world-routes.mjs): `/s/…/`, no dot segments.
const publicStream = (s) => typeof s === 'string' && /^\/s\/[A-Za-z0-9._/-]+\/$/.test(s) && !s.split('/').some(p => p === '.' || p === '..');
// B3-2b: the owner's box reaches the world's gateway (a same-origin WebSocket path) and the directory (this origin's
// `/v1/account/*`, which the front door sends to it), as the v2 page does on soul.game (v2/tools/ops/proxy/soul-game.caddy)
const samePath = (s) => typeof s === 'string' && /^\/[A-Za-z0-9._/-]*$/.test(s) && !s.startsWith('//') && !s.split('/').some(p => p === '.' || p === '..');
const sameOriginDir = (s) => typeof s === 'string' && /^\/[A-Za-z0-9._/-]*\/$/.test(s) && !s.startsWith('//') && !s.split('/').some(p => p === '.' || p === '..');
const CONFIG = /<script>window\.__simConfig=(\{.*?\})<\/script>/s;
// 24 Nov: Explore's places of a moved world, from its published snapshot: the model the new engine's world was imported
// from (W4), so the same things by the same ids. Each thing at the world root, as the old process lists it
// (apps/server god/context-view-scene.ts contextTargetRows: its point, radius and viewpoint; meaning.ts humanTitle):
// `about` marks the ones a plain listing shows (context-views.ts `discoverable`); a search reads them all.
export const searchText = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const humanTitle = (ref) => { const t = ref.replace(/^(land|place|region|g)-/, '').replace(/[-_]+/g, ' ').replace(/\//g, ' / '); return t.charAt(0).toUpperCase() + t.slice(1); };
const num = (v) => (Number.isFinite(v) ? v : 0);
export function snapshotPlaces(s) {
  const box = new Map((Array.isArray(s?.defs) ? s.defs : []).map((d) => [`${d?.name}@${d?.version}`, d?.size?.box]));
  const out = [];
  for (const e of Array.isArray(s?.entities) ? s.entities : []) {
    if (typeof e?.id !== 'string' || e.id.startsWith('h_') || e.in?.parent !== 'world' || !Array.isArray(e.p) || e.p.length !== 3) continue;
    const [x, y, z] = e.p.map(num), yaw = num(e.r), sc = Number.isFinite(e.s) && e.s > 0 ? e.s : 1, b = box.get(e.def);
    const [bx, by, bz] = Array.isArray(b) ? b.map(num) : [1, 1, 1];
    // a thing-local point (an authored viewpoint's eye and at) in the world, as localContextPoint carries it
    const at = (v) => { const [u, h, w] = v.map(num), c = Math.cos(yaw), si = Math.sin(yaw); return [x + (u * c + w * si) * sc, y + h * sc, z + (-u * si + w * c) * sc]; };
    let point = [x, y + by * sc / 2, z], radius = Math.max(0.5, Math.hypot(bx, bz) * sc / 2);
    const area = Array.isArray(e.shape?.area) && e.shape.area.length ? e.shape.area : null;
    if (area) {
      point = [area.reduce((n, q) => n + num(q[0]), 0) / area.length, num(e.params?.level), area.reduce((n, q) => n + num(q[1]), 0) / area.length];
      radius = Math.max(...area.map((q) => Math.hypot(num(q[0]) - point[0], num(q[1]) - point[2])));
    }
    const a = e.about && typeof e.about === 'object' ? e.about : null, v = a?.viewpoint;
    const viewpoint = Array.isArray(v?.eye) && Array.isArray(v?.at) && v.eye.length === 3 && v.at.length === 3 ? { eye: at(v.eye), at: at(v.at) } : undefined;
    const title = typeof a?.title === 'string' && a.title ? a.title : humanTitle(typeof e.name === 'string' && e.name ? e.name : e.id);
    const aliases = Array.isArray(a?.aliases) ? a.aliases.filter((s) => typeof s === 'string') : [];
    out.push({ target: { ref: e.id, title, ...(typeof a?.what === 'string' ? { what: a.what } : {}), point, radius, enclosed: false, ...(viewpoint ? { viewpoint } : {}) },
      shown: !!a, text: searchText(`${title} ${a?.what ?? ''} ${aliases.join(' ')}`) });
  }
  return out;
}
/** #4177: the world page with `v2Stream` (and `v2Bodies`, when given) written into its inline config
 *  (page-meta.mjs writes that `<script>` first in <head>; the page's v2-engine reads the fields).
 *  `fields` is the body catalogue's directory, or (B3-2b) an object of the page's other v2 fields (`v2Bodies`,
 *  `v2Gateway`, `v2Directory`). A page without one is returned unchanged. */
export function withV2Stream(html, stream, fields = null) {
  const extra = typeof fields === 'string' ? { v2Bodies: fields } : Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v));
  const m = CONFIG.exec(html);
  if (!m) return html;
  let config;
  try { config = JSON.parse(m[1]); } catch { return html; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return html;
  return html.slice(0, m.index) + `<script>window.__simConfig=${scriptJson({ ...config, v2Stream: stream, ...extra })}</script>` + html.slice(m.index + m[0].length);
}
// #4177: the old page's static content of a world routed to v2 (its scene, snapshot, items, platforms, config and kernel),
// published once at route time from the old world's own read-only views into the binding's `staticDir`, the directory the
// v2 origin serves beside the world's stream (`<stream>static/`). While routed, the page's reads of them are answered from
// those files, so the page loads no captured file and the old world is not asked again. /v1/config keeps its client answer.
const STATIC = { 'scene.json': '/v1/scene', 'snapshot.json': '/v1/world/snapshot', 'items.json': '/v1/edge/items',
  'platforms.json': '/v1/edge/platforms', 'config.json': '/v1/config', 'kernel.json': '/v1/kernel' };
const SERVED = new Map(Object.entries(STATIC).filter(([name]) => name !== 'config.json').map(([name, path]) => [path, name]));
const unavailable = () => Object.assign(Error('cutover.activation-unavailable'), { code: 'cutover.activation-unavailable' });
export const bindingId = ({ oldWorldId, canonicalSlug, routesFile, clientDir }) => createHash('sha256').update(JSON.stringify([oldWorldId, canonicalSlug, routesFile, clientDir])).digest('hex');

// B3-1: the body catalogue's files a routed page may read from the binding's `bodiesDir` (v2/web/body-assets.ts's names)
const BODY_FILE = /^(?:[a-z][a-z0-9_]*\.(?:json|diag)|[a-z0-9-]+\.mesh\.glb|clips-[a-z0-9-]+\.glb|models\/[a-f0-9]{64}\.(?:glb|json|mesh)|decoder\/draco_[a-z_]+\.(?:js|wasm))$/;
const bodyType = (name) => ({ json: 'application/json', glb: 'model/gltf-binary', wasm: 'application/wasm', js: 'text/javascript; charset=utf-8' })[name.split('.').pop()] ?? 'application/octet-stream';

/** The launcher's fence. A binding is one world's (`{oldWorldId, canonicalSlug, routesFile, clientDir, …}`, Eden's file
 *  as installed) or, W1 (0.133), a list of them (`{schema: 'souls/cutover-binding/2', worlds: [one world's, …]}`), each
 *  with its own route, static folder and published views; the launcher passes each request's world and the fence answers
 *  for that world's own binding. Given `binding`, that binding; otherwise the binding file (`SOULS_CUTOVER_BINDING`, else
 *  /etc/souls/cutover-binding.json), read again when it changes (looked at once a second), so the switch command
 *  (v2-switch.mjs) takes effect without a restart. No file: an ordinary old launcher until one is written. An invalid
 *  file refuses startup; written invalid later, the last valid binding stays and `log` says so. */
export function cutoverFence({ binding, file = process.env.SOULS_CUTOVER_BINDING || '/etc/souls/cutover-binding.json', log = () => {}, now = () => Date.now() } = {}) {
  if (binding !== undefined) return fenceOf(binding);
  let seen, current = null, checked = -Infinity;
  const load = (first = false) => {
    if (!first && now() - checked < 1000) return current;
    checked = now();
    let st = null; try { st = statSync(file); } catch { /* no binding (yet) */ }
    const key = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : null;
    if (key === seen) return current;
    seen = key;
    if (!st) return (current = null);
    try { current = fenceOf(JSON.parse(readFileSync(file, 'utf8'))); }
    catch { if (first) throw Error('cutover.binding-invalid'); log(`cutover: ${file} is not a valid binding; the last valid one stays`); }
    return current;
  };
  load(true);
  return {
    routeOnly: () => load()?.routeOnly() ?? [],
    inspect: (registry) => load()?.inspect(registry),
    v2Stream: (w) => load()?.v2Stream(w) ?? null,
    v2World: (w) => load()?.v2World(w) ?? null,
    v2Bodies: (w) => load()?.v2Bodies(w) ?? null,
    v2Fields: (w) => load()?.v2Fields(w) ?? null,
    publish: (w, read) => load()?.publish(w, read) ?? Promise.resolve(null),
    published: (w) => load()?.published(w) ?? false,
    publishedSeq: (w) => load()?.publishedSeq(w) ?? null,
    publishedPlaces: (w) => load()?.publishedPlaces(w) ?? null,
    handle: (req, res, w, url, o) => load()?.handle(req, res, w, url, o) ?? false,
  };
}

export const BINDINGS = 'souls/cutover-binding/2';
/** The bindings a binding file holds: a list's worlds, or the one world of a single binding. */
export const bindingsOf = (binding) => (Array.isArray(binding?.worlds) ? binding.worlds : [binding]);

/** D2 (0.134): the registry id the launcher gives a world with no old twin, one the routes file routes to the new engine
 *  that no binding binds (registry ids are `<slug>-<n>`, so the two never meet). */
export const routeOnlyId = (slug) => `v2:${slug}`;

/** D2 (0.134): a world with no old twin. Every world the binding's routes file routes to the new engine (`canonical`, not
 *  `archived`, a public stream) that no binding binds is served as one: the launcher builds its page (the old page) and
 *  lists it, and the fence answers its client, body and refused-write reads as for a bound world. It takes the first
 *  binding's routes file, client and body folders; it has no static folder (no old views: the page draws from the stream). */
function withRouteOnly(fence, bindings) {
  const first = bindings[0], bound = new Set(bindings.map((b) => b.canonicalSlug)), fences = new Map();
  const routeOnly = () => {
    let value; try { value = JSON.parse(readBounded(first.routesFile, 32 * 1024 * 1024)); } catch { return []; }
    if (value?.schema !== 'souls/world-routes/1' || !value.worlds || typeof value.worlds !== 'object' || Array.isArray(value.worlds)) return [];
    return Object.entries(value.worlds).filter(([slug, r]) => !bound.has(slug) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && r && typeof r === 'object'
      && r.canonical === true && r.archived !== true && publicStream(r.stream)).map(([slug]) => slug);
  };
  const of = (w) => {
    const slug = typeof w?.worldId === 'string' && w.worldId.startsWith('v2:') ? w.worldId.slice(3) : null;
    if (!slug || bound.has(slug) || !routeOnly().includes(slug)) return null;
    let f = fences.get(slug);
    if (!f) fences.set(slug, f = oneFence({ oldWorldId: routeOnlyId(slug), canonicalSlug: slug, routesFile: first.routesFile, clientDir: first.clientDir,
      ...(first.bodiesDir ? { bodiesDir: first.bodiesDir } : first.v2Bodies ? { v2Bodies: first.v2Bodies } : {}), ...(first.v2Directory ? { v2Directory: first.v2Directory } : {}) }));
    return f;
  };
  return {
    routeOnly,
    inspect: (registry) => ({ ...fence.inspect(registry), routeOnly: routeOnly() }),
    v2Stream: (w) => (of(w) ?? fence).v2Stream(w),
    v2World: (w) => (of(w) ?? fence).v2World(w),
    v2Bodies: (w) => (of(w) ?? fence).v2Bodies(w),
    v2Fields: (w) => (of(w) ?? fence).v2Fields(w),
    publish: (w, read) => (of(w) ? Promise.resolve(null) : fence.publish(w, read)),
    published: (w) => (of(w) ? false : fence.published(w)),
    publishedSeq: (w) => (of(w) ? null : fence.publishedSeq(w)),
    publishedPlaces: (w) => (of(w) ? null : fence.publishedPlaces(w)),
    handle: (req, res, w, url, o) => (of(w) ?? fence).handle(req, res, w, url, o),
  };
}

function fenceOf(binding) {
  if (!binding || typeof binding !== 'object' || (binding.worlds === undefined && binding.schema === undefined)) return withRouteOnly(oneFence(binding), [binding]);
  if (binding.schema !== BINDINGS || !Array.isArray(binding.worlds) || !binding.worlds.length) throw Error('cutover.binding-invalid');
  const fences = binding.worlds.map(oneFence);
  const distinct = (key) => { const v = binding.worlds.map((b) => b[key]).filter((x) => x !== undefined); return new Set(v).size === v.length; };
  // one entry per world, and never two worlds publishing into one static folder (each clears its own on rollback)
  if (!distinct('canonicalSlug') || !distinct('oldWorldId') || !distinct('staticDir')) throw Error('cutover.binding-invalid');
  const of = (w) => fences.find((f) => f.bound(w));
  return withRouteOnly({
    inspect: (registry) => ({ configured: true, worlds: fences.map((f) => f.inspect(registry)) }),
    v2Stream: (w) => of(w)?.v2Stream(w) ?? null,
    v2World: (w) => of(w)?.v2World(w) ?? null,
    v2Bodies: (w) => of(w)?.v2Bodies(w) ?? null,
    v2Fields: (w) => of(w)?.v2Fields(w) ?? null,
    publish: (w, read) => of(w)?.publish(w, read) ?? Promise.resolve(null),
    published: (w) => of(w)?.published(w) ?? false,
    publishedSeq: (w) => of(w)?.publishedSeq(w) ?? null,
    publishedPlaces: (w) => of(w)?.publishedPlaces(w) ?? null,
    handle: (req, res, w, url, o) => of(w)?.handle(req, res, w, url, o) ?? false,
  }, binding.worlds);
}

function oneFence(binding) {
  if (!binding || typeof binding.oldWorldId !== 'string' || !binding.oldWorldId.length || binding.oldWorldId.length > 256 || /[\x00-\x1f\x7f]/.test(binding.oldWorldId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.canonicalSlug)
      || !isAbsolute(binding.routesFile ?? '') || !isAbsolute(binding.clientDir ?? '') || (binding.staticDir !== undefined && !isAbsolute(binding.staticDir)) || (binding.v2Bodies !== undefined && !sameOriginDir(binding.v2Bodies)) || (binding.bodiesDir !== undefined && !isAbsolute(binding.bodiesDir))
      || (binding.v2Gateway !== undefined && !samePath(binding.v2Gateway)) || (binding.v2Directory !== undefined && binding.v2Directory !== '/')) throw Error('cutover.binding-invalid');
  // v2Bodies: the same-origin directory serving the v2 body catalogue (bodies.json and its models), as the operator places it.
  // bodiesDir (B3-1): a built body-assets folder (V2_BODY_ASSETS) this launcher serves at the world's `v2/bodies/` while
  // routed; v2Bodies then defaults to that path.
  const { oldWorldId, canonicalSlug, routesFile, clientDir, staticDir, bodiesDir } = binding;
  const v2Bodies = binding.v2Bodies ?? (bodiesDir ? `/w/${canonicalSlug}/v2/bodies/` : null);
  let publishing = null, published = null; // the flight, and the stream the files in staticDir were published for
  // 24 Nov: a static folder the launcher cannot write (its unit's ProtectSystem=strict sandbox) never leaves a routed page
  // without its views: they are held here instead, for the stream they were read for, and served as the files would be
  let held = null, seqOf = null; // seqOf: the published snapshot's seq answer and places, by its sha256 (publishedSnapshot)
  // The manifest goes first: without it nothing here is served, so a reader never mixes one routing's files with another's
  // while they are removed or rewritten. Then the six files (and any `.tmp` a stopped publish left).
  const clear = () => {
    held = null;
    if (!staticDir) return;
    rmSync(join(staticDir, 'manifest.json'), { force: true });
    for (const name of [...Object.keys(STATIC), 'manifest.json']) { rmSync(join(staticDir, name), { force: true }); rmSync(join(staticDir, `${name}.tmp`), { force: true }); }
  };
  const manifest = () => { try { return JSON.parse(readBounded(join(staticDir, 'manifest.json'), 1024 * 1024)); } catch { return null; } };
  // one published view for `stream`: the file in staticDir, else the view held in memory, else null (the old world answers)
  const view = (stream, name) => {
    if (!staticDir || !stream) return null;
    const m = manifest();
    if (m?.files?.[name] && m.stream === stream) return readBounded(join(staticDir, name), 64 * 1024 * 1024);
    return held?.m.stream === stream && held.m.files[name] ? held.bodies[name] : null;
  };
  const route = () => {
    try {
      const value = JSON.parse(readBounded(routesFile, 32 * 1024 * 1024));
      if (!value || value.schema !== 'souls/world-routes/1' || !value.worlds || typeof value.worlds !== 'object' || Array.isArray(value.worlds)
          || !Object.hasOwn(value.worlds, canonicalSlug)) throw unavailable();
      const route = value.worlds[canonicalSlug];
      if (!route || typeof route !== 'object' || Array.isArray(route) || (route.canonical !== undefined && typeof route.canonical !== 'boolean')) throw unavailable();
      return route;
    } catch { throw unavailable(); }
  };
  const active = () => route().canonical === true;
  // The replica the routed page loads, by version (cdn-walk, 24 Nov: `/replica_bg.wasm` answered no-store, so every
  // viewer fetched its 2 MB again). `<world>/v2/replica/<version>/` holds replica.js and the replica_bg.wasm it loads
  // beside itself, the version being the first 16 hex of sha256 over both files, so the page's two files always match
  // and the current version's answers are immutable. The plain `/replica.js` and `/replica_bg.wasm` the Soul client's
  // upgrade reads keep no-store. Read again when either file's size or time changes.
  let replica = null;
  const replicaNow = () => {
    const key = ['replica.js', 'replica_bg.wasm'].map((n) => { const s = statSync(join(clientDir, n)); return `${s.ino}:${s.size}:${s.mtimeMs}`; }).join('/');
    if (replica?.key !== key) {
      const js = readBounded(join(clientDir, 'replica.js'), 32 * 1024 * 1024), wasm = readBounded(join(clientDir, 'replica_bg.wasm'), 32 * 1024 * 1024);
      replica = { key, js, wasm, version: createHash('sha256').update(js).update(wasm).digest('hex').slice(0, 16) };
    }
    return replica;
  };
  const replicaVersion = () => { try { return replicaNow().version; } catch { return null; } };
  const bound = (w) => !!w && worldIdOf(w) === oldWorldId;
  return {
    bound,
    inspect(registry) {
      const w = registry.worlds.find(bound);
      if (!w) throw Error('cutover.binding-world-missing');
      try {
        const c = JSON.parse(answer(clientDir, '/v1/config').body).soulClient;
        if (c.contract !== 'souls-v2/1' || !/^\d+\.\d+\.\d+$/.test(c.version) || !Array.isArray(c.files)) throw Error();
        for (const [name, described] of [['eden.mjs', c], ['skill.md', c.skill], ...['replica.js', 'replica_bg.wasm'].map(name => [name, c.files.find(f => f.name === name)])]) {
          const got = answer(clientDir, `/${name}`)?.body;
          if (!got || got.length !== described?.bytes || createHash('sha256').update(got).digest('hex') !== described.sha256) throw Error();
        }
      } catch { throw Error('cutover.client-unavailable'); }
      return { configured: true, oldWorldId, canonicalSlug, bindingId: bindingId(binding), active: active() };
    },
    /** #4177: the v2 stream the bound world's page reads (its route's `stream`) while the world is routed to v2, else
     *  null: another world, the switch off, or an activation that cannot be verified (its reads answer 503 then). */
    v2Stream(w) {
      if (!bound(w)) return null;
      let stream = null;
      try { const r = route(); stream = r.canonical === true && publicStream(r.stream) ? r.stream : null; } catch { /* unverifiable: not routed */ }
      if (stream !== published) published = null; // rolled back (or re-routed): the next routing publishes afresh
      // rolled back (or the routing cannot be verified): the previous routing's files go, so a re-route never serves them
      if (!stream && staticDir && !publishing && (held || existsSync(join(staticDir, 'manifest.json')))) { try { clear(); } catch { /* an unwritable folder: nothing of it is served */ } }
      return stream;
    },
    /** The world's name in the new engine (its routes key, the `world` its Souls are paired for), under the same rule as
     *  `v2Stream` (routed, else null): the home page's My Souls reads a moved world's Souls from the directory by it. */
    v2World(w) { return this.v2Stream(w) ? canonicalSlug : null; },
    /** #4177: the body catalogue's directory for the page, under the same rule as `v2Stream` (routed, else null). */
    v2Bodies(w) { return v2Bodies && this.v2Stream(w) ? v2Bodies : null; },
    /** B3-2b: every v2 field the routed page's inline config carries beside `v2Stream` (null when not routed): the body
     *  catalogue's directory, and where the owner's box finds the gateway and the directory (the binding's, else the
     *  front door's paths: `/w/<world>/v2/ws` and `/`). */
    v2Fields(w) {
      if (!this.v2Stream(w)) return null;
      // R2 (0.133): the world's public history export (its route's `history`, `/s/…/`), for the page's past time
      let history = null;
      try { const r = route(); history = publicStream(r.history) ? r.history : null; } catch { /* none */ }
      const version = replicaVersion();
      return { ...(v2Bodies ? { v2Bodies } : {}), v2Gateway: binding.v2Gateway ?? `/w/${canonicalSlug}/v2/ws`, v2Directory: binding.v2Directory ?? '/', ...(history ? { v2History: history } : {}),
        ...(version ? { v2Replica: `/w/${canonicalSlug}/v2/replica/${version}/replica.js` } : {}) };
    },
    /** #4177: at route time, the old world's static views (`read(path)` -> `{ status, body }` from its process) written
     *  into staticDir, each file whole (`.tmp`, then renamed; the origin never serves a `.tmp`), the manifest last. Once
     *  per routing: a later call for the same stream does nothing. Resolves to the manifest, or null (not routed, or no
     *  staticDir); rejects when the old world does not answer its snapshot (nothing is then served: its views answer live).
     *  A staticDir the launcher cannot write (24 Nov: EROFS under the unit's sandbox) holds the views in memory instead:
     *  that flight's manifest names why (`unwritable`, for the launcher's log line) and the page is served the same. */
    publish(w, read) {
      const stream = staticDir ? this.v2Stream(w) : null;
      if (!stream) { published = null; return Promise.resolve(null); }
      if (published === stream) return Promise.resolve(held?.m.stream === stream ? held.m : manifest());
      return publishing ??= (async () => {
        const files = {}, bodies = {};
        let unwritable = null;
        try { mkdirSync(staticDir, { recursive: true }); clear(); } catch (e) { unwritable = e; held = null; }
        for (const [name, path] of Object.entries(STATIC)) {
          let a; try { a = await read(path); } catch { a = null; }
          if (a?.status !== 200) { if (name === 'snapshot.json') { try { clear(); } catch { /* unwritable */ } throw Error('cutover.static-snapshot-unavailable'); } continue; }
          bodies[name] = a.body;
          files[name] = { from: path, bytes: a.body.length, sha256: createHash('sha256').update(a.body).digest('hex') };
        }
        const m = { schema: 'souls/old-static/1', world: canonicalSlug, oldWorldId, stream, files };
        try {
          if (unwritable) throw unwritable;
          for (const name of Object.keys(files)) { writeFileSync(join(staticDir, `${name}.tmp`), bodies[name]); renameSync(join(staticDir, `${name}.tmp`), join(staticDir, name)); }
          writeFileSync(join(staticDir, 'manifest.json.tmp'), JSON.stringify(m)); renameSync(join(staticDir, 'manifest.json.tmp'), join(staticDir, 'manifest.json'));
        } catch (e) {
          try { clear(); } catch { /* the folder stays as it was; its manifest, if any, names another stream */ }
          held = { m, bodies };
          published = stream;
          return { ...m, unwritable: `${staticDir}: ${e?.code ?? e?.message ?? e}` };
        }
        published = stream;
        return m;
      })().finally(() => { publishing = null; });
    },
    /** `o.config()`: the routed world's page config, which its `/v1/config` answers beside `soulClient` (else only that).
     *  `o.cold`: the world has no old process to ask (24 Nov; D2b: every moved world, launcher.mjs oldCold): a view not
     *  published for this stream is then answered 404 `world.new-engine`, as for a world with no old twin, and the page
     *  draws the world from its stream (W2, stream-scene.ts). */
    /** Whether the old views are published for the world's current stream (its snapshot, in staticDir or held). */
    published(w) {
      const stream = this.v2Stream(w);
      if (!stream || !staticDir) return false;
      const m = manifest();
      return (m?.stream === stream && !!m.files?.['snapshot.json']) || (held?.m.stream === stream && !!held.m.files['snapshot.json']);
    },
    /** 24 Nov: the published snapshot's `/v1/world/seq` answer ({seq, entities, builds}, as apps/server god/routes.ts
     *  gives it), for the page's heartbeat while the old process sleeps (launcher.mjs oldCold); null when none is
     *  published. Parsed once per published snapshot (its sha256), not once per poll. */
    publishedSeq(w) { return this.publishedSnapshot(w)?.v ?? null; },
    /** 24 Nov: the published snapshot's places (`snapshotPlaces`) and its seq, for Explore's `/v1/world/context` while
     *  the old process sleeps; null when none is published. Read with the seq, once per published snapshot. */
    publishedPlaces(w) { const p = this.publishedSnapshot(w); return p ? { seq: p.v.seq, places: p.places } : null; },
    publishedSnapshot(w) {
      const stream = this.v2Stream(w);
      if (!stream || !staticDir) return null;
      const m = manifest(), f = m?.stream === stream ? m.files?.['snapshot.json'] : held?.m.stream === stream ? held.m.files['snapshot.json'] : null;
      if (!f) return null;
      if (seqOf && seqOf.stream === stream && f.sha256 && seqOf.sha === f.sha256) return seqOf;
      let s; try { s = JSON.parse(view(stream, 'snapshot.json')); } catch { return null; }
      const v = { seq: Number.isFinite(s?.seq) ? s.seq : 0, entities: Array.isArray(s?.entities) ? s.entities.length : 0, ...(Number.isFinite(s?.buildsRev) ? { builds: s.buildsRev } : {}) };
      seqOf = { stream, sha: f.sha256 ?? null, v, places: snapshotPlaces(s) };
      return seqOf;
    },
    handle(req, res, w, url, o) {
      if (!bound(w)) return false; // A damaged Eden activation never prevents another world from operating.
      const path = url.pathname.replace(/^.*\/(?:w|__sim\/worlds)\/[^/]+/, '') || '/';
      const read = req.method === 'GET' || req.method === 'HEAD';
      // V4 (0.133): Explore's place pictures are asked for by POST but change nothing: the old world renders its own
      // architecture, which a moved world keeps (its ground and buildings are the old twin's), so they pass through.
      const mutating = (!read && !(req.method === 'POST' && path === '/v1/world/context/views')) || (path === '/v1/edge/view' && url.searchParams.has('gaze'));
      const body = bodiesDir && !mutating && path.startsWith('/v2/bodies/') ? path.slice('/v2/bodies/'.length) : null;
      const capture = mutating ? null : /^\/v1\/scenes\/([a-f0-9]{64})$/.exec(path)?.[1] ?? null;
      const versioned = mutating ? null : /^\/v2\/replica\/([0-9a-f]{16})\/(replica\.js|replica_bg\.wasm)$/.exec(path);
      if (!mutating && !files.has(path) && !SERVED.has(path) && body === null && capture === null && !versioned) return false;
      let on;
      try { on = active(); } catch {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'cutover.activation-unavailable', message: 'The engine switch cannot be verified. Try again after the operator restores its activation record.' }));
        return true;
      }
      if (!on) {
        if (read && path === '/v1/config') res.setHeader('x-souls-engine', 'old');
        return false;
      }
      if (body !== null) {
        // B3-1: the routed page's body catalogue, from the binding's bodiesDir; a name outside the catalogue's is not here
        let bytes = null;
        try { if (BODY_FILE.test(body) && !url.search) bytes = readBounded(join(bodiesDir, body), 64 * 1024 * 1024); } catch { bytes = null; }
        if (!bytes) { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'not-found' })); return true; }
        res.writeHead(200, { 'content-type': bodyType(body), 'content-length': bytes.length, 'cache-control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : bytes);
        return true;
      }
      if (versioned) {
        // The current version is immutable; another (a page loaded before the client changed) gets today's bytes, kept nowhere.
        let r = null;
        try { r = replicaNow(); } catch { r = null; }
        if (!r) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'cutover.client-unavailable', message: 'The new engine client is unavailable. Ask the operator to restore the served bundle.' })); return true; }
        const bytes = versioned[2] === 'replica.js' ? r.js : r.wasm, current = versioned[1] === r.version && !url.search;
        res.writeHead(200, { 'content-type': types[versioned[2]], 'content-length': bytes.length, 'cache-control': current ? 'public, max-age=31536000, immutable' : 'no-store' }).end(req.method === 'HEAD' ? undefined : bytes);
        return true;
      }
      if (capture !== null) {
        // W4 prep (0.133): the page binds the scenery the published scene.json names, by its hash. The old world keeps a
        // scene's capture only once one of its takes carried it, so a world loaded for the switch (or one nobody watched
        // since its scene last changed) answers 404 and the page stops at "World layout could not be prepared". The
        // published scene is that capture: answered as the old world answers it (`{worldId, ...capture}`, http.ts),
        // only for this stream's file and this world; any other hash passes through.
        const world = url.searchParams.get('world');
        let json = null;
        try {
          const published = (world === null || world === oldWorldId) && [...url.searchParams.keys()].every((k) => k === 'world') ? view(this.v2Stream(w), 'scene.json') : null;
          if (published) {
            const { renderSceneRef: ref, ...scene } = JSON.parse(published);
            if (ref?.hash === capture) json = JSON.stringify({ worldId: oldWorldId, contract: 'render-scene-capture/1', ref, body: scene });
          }
        } catch { json = null; }
        if (json === null) return false;
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store', 'x-souls-static': 'published' })
          .end(req.method === 'HEAD' ? undefined : json);
        return true;
      }
      if (SERVED.has(path)) {
        // #4177: published for this stream: the page reads the file; not yet (or none): the old world's live view answers,
        // or, its process not running, none does (the page draws from the stream). The snapshot's wire forms (`?defs=ref`,
        // `&cols=1`, `&v=<key>`; apps/web/src/snapshot-wire.ts) are answered with the plain one: an answer without
        // x-defs-ref and x-ground-ref is the plain snapshot to the page. Any other query passes through.
        const plain = !url.search || (path === '/v1/world/snapshot' && [...url.searchParams.keys()].every((k) => k === 'defs' || k === 'cols' || k === 'v'));
        let body = null;
        try { if (plain) body = view(this.v2Stream(w), SERVED.get(path)); } catch { body = null; }
        if (!body && plain && o?.cold) {
          res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'world.new-engine', message: 'This world runs on the new engine; its old view is not published, and the page draws it from its stream.' }));
          return true;
        }
        if (!body) return false;
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-cache', 'x-souls-static': 'published' }).end(req.method === 'HEAD' ? undefined : body);
        return true;
      }
      if (mutating) {
        res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'world.new-engine', message: 'This world uses the new engine. Run: node eden.mjs upgrade' }));
        return true;
      }
      let a = answer(clientDir, path);
      // the routed world's page config (launcher.mjs movedConfig, `o.config`) beside the client's `soulClient`, as an old
      // world's /v1/config gives both: a page that reads the route gets what its inline config says
      if (a && path === '/v1/config' && o?.config) {
        let page = null; try { page = o.config(); } catch { page = null; }
        if (page) a = { ...a, body: Buffer.from(JSON.stringify({ ...page, soulClient: JSON.parse(a.body).soulClient })) };
      }
      if (!a) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'cutover.client-unavailable', message: 'The new engine client is unavailable. Ask the operator to restore the served bundle.' }));
      } else res.writeHead(a.status, { 'content-type': a.type, 'content-length': a.body.length, 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : a.body);
      return true;
    },
  };
}

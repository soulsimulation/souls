// The operator binds the old registry identity to one canonical v2 route. The canonical flag is the only switch.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { worldIdOf } from './registry.mjs';
import { scriptJson } from '../../apps/server/src/inline-config.ts';

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
const sameOriginDir = (s) => typeof s === 'string' && /^\/[A-Za-z0-9._/-]*\/$/.test(s) && !s.startsWith('//') && !s.split('/').some(p => p === '.' || p === '..');
const CONFIG = /<script>window\.__simConfig=(\{.*?\})<\/script>/s;
/** #4177: the world page with `v2Stream` (and `v2Bodies`, when given) written into its inline config
 *  (apps/server/src/inline-config.ts writes that `<script>` first in <head>; the page's v2-engine reads the fields).
 *  A page without one is returned unchanged. */
export function withV2Stream(html, stream, bodies = null) {
  const m = CONFIG.exec(html);
  if (!m) return html;
  let config;
  try { config = JSON.parse(m[1]); } catch { return html; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return html;
  return html.slice(0, m.index) + `<script>window.__simConfig=${scriptJson({ ...config, v2Stream: stream, ...(bodies ? { v2Bodies: bodies } : {}) })}</script>` + html.slice(m.index + m[0].length);
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

/** The launcher's fence. Given `binding`, that binding; otherwise the binding file (`SOULS_CUTOVER_BINDING`, else
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
    inspect: (registry) => load()?.inspect(registry),
    v2Stream: (w) => load()?.v2Stream(w) ?? null,
    v2Bodies: (w) => load()?.v2Bodies(w) ?? null,
    publish: (w, read) => load()?.publish(w, read) ?? Promise.resolve(null),
    handle: (req, res, w, url) => load()?.handle(req, res, w, url) ?? false,
  };
}

function fenceOf(binding) {
  if (!binding || typeof binding.oldWorldId !== 'string' || !binding.oldWorldId.length || binding.oldWorldId.length > 256 || /[\x00-\x1f\x7f]/.test(binding.oldWorldId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.canonicalSlug)
      || !isAbsolute(binding.routesFile ?? '') || !isAbsolute(binding.clientDir ?? '') || (binding.staticDir !== undefined && !isAbsolute(binding.staticDir)) || (binding.v2Bodies !== undefined && !sameOriginDir(binding.v2Bodies)) || (binding.bodiesDir !== undefined && !isAbsolute(binding.bodiesDir))) throw Error('cutover.binding-invalid');
  // v2Bodies: the same-origin directory serving the v2 body catalogue (bodies.json and its models), as the operator places it.
  // bodiesDir (B3-1): a built body-assets folder (V2_BODY_ASSETS) this launcher serves at the world's `v2/bodies/` while
  // routed; v2Bodies then defaults to that path.
  const { oldWorldId, canonicalSlug, routesFile, clientDir, staticDir, bodiesDir } = binding;
  const v2Bodies = binding.v2Bodies ?? (bodiesDir ? `/w/${canonicalSlug}/v2/bodies/` : null);
  let publishing = null, published = null; // the flight, and the stream the files in staticDir were published for
  // The manifest goes first: without it nothing here is served, so a reader never mixes one routing's files with another's
  // while they are removed or rewritten. Then the six files (and any `.tmp` a stopped publish left).
  const clear = () => {
    if (!staticDir) return;
    rmSync(join(staticDir, 'manifest.json'), { force: true });
    for (const name of [...Object.keys(STATIC), 'manifest.json']) { rmSync(join(staticDir, name), { force: true }); rmSync(join(staticDir, `${name}.tmp`), { force: true }); }
  };
  const manifest = () => { try { return JSON.parse(readBounded(join(staticDir, 'manifest.json'), 1024 * 1024)); } catch { return null; } };
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
  const bound = (w) => !!w && worldIdOf(w) === oldWorldId;
  return {
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
      if (!stream && staticDir && !publishing && existsSync(join(staticDir, 'manifest.json'))) clear();
      return stream;
    },
    /** #4177: the body catalogue's directory for the page, under the same rule as `v2Stream` (routed, else null). */
    v2Bodies(w) { return v2Bodies && this.v2Stream(w) ? v2Bodies : null; },
    /** #4177: at route time, the old world's static views (`read(path)` -> `{ status, body }` from its process) written
     *  into staticDir, each file whole (`.tmp`, then renamed; the origin never serves a `.tmp`), the manifest last. Once
     *  per routing: a later call for the same stream does nothing. Resolves to the manifest, or null (not routed, or no
     *  staticDir); rejects when the old world does not answer its snapshot (nothing is then served: its views answer live). */
    publish(w, read) {
      const stream = staticDir ? this.v2Stream(w) : null;
      if (!stream) { published = null; return Promise.resolve(null); }
      if (published === stream) return Promise.resolve(manifest());
      return publishing ??= (async () => {
        const files = {};
        mkdirSync(staticDir, { recursive: true });
        clear();
        for (const [name, path] of Object.entries(STATIC)) {
          let a; try { a = await read(path); } catch { a = null; }
          if (a?.status !== 200) { if (name === 'snapshot.json') { clear(); throw Error('cutover.static-snapshot-unavailable'); } continue; }
          writeFileSync(join(staticDir, `${name}.tmp`), a.body); renameSync(join(staticDir, `${name}.tmp`), join(staticDir, name));
          files[name] = { from: path, bytes: a.body.length, sha256: createHash('sha256').update(a.body).digest('hex') };
        }
        const m = { schema: 'souls/old-static/1', world: canonicalSlug, oldWorldId, stream, files };
        writeFileSync(join(staticDir, 'manifest.json.tmp'), JSON.stringify(m)); renameSync(join(staticDir, 'manifest.json.tmp'), join(staticDir, 'manifest.json'));
        published = stream;
        return m;
      })().finally(() => { publishing = null; });
    },
    handle(req, res, w, url) {
      if (!bound(w)) return false; // A damaged Eden activation never prevents another world from operating.
      const path = url.pathname.replace(/^.*\/(?:w|__sim\/worlds)\/[^/]+/, '') || '/';
      const read = req.method === 'GET' || req.method === 'HEAD';
      const mutating = !read || (path === '/v1/edge/view' && url.searchParams.has('gaze'));
      const body = bodiesDir && !mutating && path.startsWith('/v2/bodies/') ? path.slice('/v2/bodies/'.length) : null;
      if (!mutating && !files.has(path) && !SERVED.has(path) && body === null) return false;
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
      if (SERVED.has(path)) {
        // #4177: published for this stream: the page reads the file; not yet (or none): the old world's live view answers.
        // Only the query-less form is published: the snapshot's wire forms (`?defs=ref`, `&cols=1`; apps/server/src/god/
        // routes.ts) differ in body and headers (x-defs-ref, x-ground-ref, column-packed entities), so they pass through.
        const name = SERVED.get(path), m = staticDir ? manifest() : null;
        let body = null;
        try { if (m?.files?.[name] && m.stream === this.v2Stream(w) && !url.search) body = readBounded(join(staticDir, name), 64 * 1024 * 1024); } catch { body = null; }
        if (!body) return false;
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-cache', 'x-souls-static': 'published' }).end(req.method === 'HEAD' ? undefined : body);
        return true;
      }
      if (mutating) {
        res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'world.new-engine', message: 'This world uses the new engine. Run: node eden.mjs upgrade' }));
        return true;
      }
      const a = answer(clientDir, path);
      if (!a) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: false, code: 'cutover.client-unavailable', message: 'The new engine client is unavailable. Ask the operator to restore the served bundle.' }));
      } else res.writeHead(a.status, { 'content-type': a.type, 'content-length': a.body.length, 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : a.body);
      return true;
    },
  };
}

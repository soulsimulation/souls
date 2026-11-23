// The operator binds the old registry identity to one canonical v2 route. The canonical flag is the only switch.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
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

export function cutoverFence({ binding, file = process.env.SOULS_CUTOVER_BINDING || '/etc/souls/cutover-binding.json' } = {}) {
  if (binding === undefined) {
    // Only an absent initial configuration means an ordinary, unconfigured old launcher.
    if (!existsSync(file)) {
      if (process.env.SOULS_CUTOVER_BINDING || file !== '/etc/souls/cutover-binding.json') throw Error('cutover.binding-unavailable');
      return null;
    }
    try { binding = JSON.parse(readFileSync(file, 'utf8')); } catch { throw Error('cutover.binding-invalid'); }
  }
  if (!binding || typeof binding.oldWorldId !== 'string' || !binding.oldWorldId.length || binding.oldWorldId.length > 256 || /[\x00-\x1f\x7f]/.test(binding.oldWorldId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.canonicalSlug)
      || !isAbsolute(binding.routesFile ?? '') || !isAbsolute(binding.clientDir ?? '') || (binding.staticDir !== undefined && !isAbsolute(binding.staticDir)) || (binding.v2Bodies !== undefined && !sameOriginDir(binding.v2Bodies))) throw Error('cutover.binding-invalid');
  // v2Bodies: the same-origin directory serving the v2 body catalogue (bodies.json and its models), as the operator places it
  const { oldWorldId, canonicalSlug, routesFile, clientDir, staticDir, v2Bodies = null } = binding;
  let publishing = null, published = null; // the flight, and the stream the files in staticDir were published for
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
      return stream;
    },
    /** #4177: the body catalogue's directory for the page, under the same rule as `v2Stream` (routed, else null). */
    v2Bodies(w) { return v2Bodies && this.v2Stream(w) ? v2Bodies : null; },
    /** #4177: at route time, the old world's static views (`read(path)` -> `{ status, body }` from its process) written
     *  into staticDir, each file whole (`.tmp`, then renamed; the origin never serves a `.tmp`), the manifest last. Once
     *  per routing: a later call for the same stream does nothing. Resolves to the manifest, or null (not routed, no
     *  staticDir, or the old world did not answer its snapshot). */
    publish(w, read) {
      const stream = staticDir ? this.v2Stream(w) : null;
      if (!stream) { published = null; return Promise.resolve(null); }
      if (published === stream) return Promise.resolve(manifest());
      return publishing ??= (async () => {
        const files = {};
        mkdirSync(staticDir, { recursive: true });
        for (const [name, path] of Object.entries(STATIC)) {
          let a; try { a = await read(path); } catch { a = null; }
          if (a?.status !== 200) { if (name === 'snapshot.json') return null; continue; }
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
      if (!mutating && !files.has(path) && !SERVED.has(path)) return false;
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
      if (SERVED.has(path)) {
        // #4177: published for this stream: the page reads the file; not yet (or none): the old world's live view answers
        const name = SERVED.get(path), m = staticDir ? manifest() : null;
        let body = null;
        try { if (m?.files?.[name] && m.stream === this.v2Stream(w) && !(path !== '/v1/world/snapshot' && url.search)) body = readBounded(join(staticDir, name), 64 * 1024 * 1024); } catch { body = null; }
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

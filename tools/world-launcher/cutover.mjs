// The operator binds the old registry identity to one canonical v2 route. The canonical flag is the only switch.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
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
const CONFIG = /<script>window\.__simConfig=(\{.*?\})<\/script>/s;
/** #4177: the world page with `v2Stream` written into its inline config (apps/server/src/inline-config.ts writes that
 *  `<script>` first in <head>; the page's use-v2-souls.ts reads the field). A page without one is returned unchanged. */
export function withV2Stream(html, stream) {
  const m = CONFIG.exec(html);
  if (!m) return html;
  let config;
  try { config = JSON.parse(m[1]); } catch { return html; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return html;
  return html.slice(0, m.index) + `<script>window.__simConfig=${scriptJson({ ...config, v2Stream: stream })}</script>` + html.slice(m.index + m[0].length);
}
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
      || !isAbsolute(binding.routesFile ?? '') || !isAbsolute(binding.clientDir ?? '')) throw Error('cutover.binding-invalid');
  const { oldWorldId, canonicalSlug, routesFile, clientDir } = binding;
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
      try { const r = route(); return r.canonical === true && publicStream(r.stream) ? r.stream : null; } catch { return null; }
    },
    handle(req, res, w, url) {
      if (!bound(w)) return false; // A damaged Eden activation never prevents another world from operating.
      const path = url.pathname.replace(/^.*\/(?:w|__sim\/worlds)\/[^/]+/, '') || '/';
      const read = req.method === 'GET' || req.method === 'HEAD';
      const mutating = !read || (path === '/v1/edge/view' && url.searchParams.has('gaze'));
      if (!mutating && !files.has(path)) return false;
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

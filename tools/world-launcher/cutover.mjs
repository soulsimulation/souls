// The operator binds the old registry identity to one canonical v2 route. The canonical flag is the only switch.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { readWorldRoutes } from '../../v2/tools/origin/world-routes.mjs';
import { answer } from '../../v2/client/served/serve.mjs';
import { worldIdOf } from './registry.mjs';

const files = new Set(['/v1/config', '/eden.mjs', '/skill.md', '/creator.md', '/instructions.md', '/llms.txt', '/replica.js', '/replica_bg.wasm']);
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
  const active = () => {
    try {
      const route = readWorldRoutes(routesFile)[canonicalSlug];
      if (!route) throw unavailable();
      return route.canonical;
    } catch { throw unavailable(); }
  };
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

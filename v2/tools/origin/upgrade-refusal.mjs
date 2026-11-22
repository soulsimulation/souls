// The frozen upgrade answer, kept after today's launcher is gone (#4038; the launcher's is apps/server/src/client-minimum.ts,
// #1937, frozen in docs/architecture/api.md "Soul client upgrade"). A Soul's own call under /w/<slug>/v1/edge or
// /w/<slug>/v1/agent, from a client whose bare `x-soul-client` version is below the served client's `minVersion`, gets
// HTTP 426 with the launcher's exact body, which every released client prints. No header counts as 2.32.0; a header that
// is not a bare version is never refused; nobody is refused while the minimum is above the client served. A call counts as
// a Soul's when it carries a bearer token. The routes a client upgrades through are not under these prefixes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const UPGRADE_RUN = 'node eden.mjs upgrade';
export const UPGRADE_MESSAGE = `This Soul client is too old for this world. Run: ${UPGRADE_RUN}`;
const UNNAMED_CLIENT = '2.32.0', BARE = /^\d+\.\d+\.\d+$/, GUARDED = /^\/w\/[a-z0-9][a-z0-9-]*\/v1\/(edge|agent)(\/|$)/;
const older = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

/** The refusal for a request, or null. `served` is `soulClient` (minVersion, version) from the served client's soul-client.json. */
export function refusalFor(path, headers, served) {
  if (!GUARDED.test(path) || !served || !/^Bearer\s+\S/i.test(headers.authorization ?? '')) return null;
  const have = headers['x-soul-client'] || UNNAMED_CLIENT, min = served.minVersion;
  if (!BARE.test(have) || !BARE.test(min) || !older(have, min)) return null;
  if (!BARE.test(served.version) || older(served.version, min)) return null;
  return { ok: false, code: 'client.upgrade-required', message: UPGRADE_MESSAGE, min, have, run: UPGRADE_RUN };
}

/** `handle(req, res)` answers a refused request and returns true, else false. `client` is the served client's folder. */
export function upgradeRefusal(client = process.env.SOULS_CLIENT || '/usr/local/lib/souls/client') {
  return {
    handle(req, res) {
      const path = new URL(req.url, 'http://origin').pathname;
      if (!GUARDED.test(path)) return false;
      let served; try { served = JSON.parse(readFileSync(join(client, 'soul-client.json'), 'utf8')); } catch { return false; }
      const r = refusalFor(path, req.headers, served);
      if (!r) return false;
      const body = JSON.stringify(r);
      res.writeHead(426, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : body);
      return true;
    },
  };
}

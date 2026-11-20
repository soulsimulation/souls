// A world serving the new answers, for the compatibility tests (Engine v2 R18, #2821). It needs nothing outside v2/.
//
// - The frozen upgrade path (docs/architecture/api.md, "Soul client upgrade"): `GET <world>/v1/config` describes the
//   client it serves as `soulClient`, `GET <world>/eden.mjs` serves it, plain 200, no redirect, no sign-in. A Soul's
//   request under /v1/edge or /v1/agent from a client below the minimum gets 426 `client.upgrade-required`.
// - The directory's pairing (W2) for a Soul X11 brought over: a request names the Soul's `former` id and its `world`;
//   the owner's approval pairs the Soul X11's table holds for that former id, and only for its own account; the poll
//   answers `{token, grant, former}`. directoryd answers the same (`v2/client/src/pair/former.test.mjs`).

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const UPGRADE_REQUIRED = (min, have) => ({
  ok: false, code: 'client.upgrade-required', message: 'This Soul client is too old for this world. Run: node eden.mjs upgrade', min, have, run: 'node eden.mjs upgrade',
});

const newer = (a, b) => {
  const p = (v) => String(v ?? '0').split('.').map(Number), x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0; }
  return false;
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Starts the world on 127.0.0.1. `client` is the bundle served at /eden.mjs (its `const VERSION` line names its version),
 * `imported` X11's table: `{ <world>: { <former id>: { account, grant } } }`. Returns its url, the counts and `approve`.
 */
export async function frozenWorld({ slug = 'eden', client, contract = 'souls-v2/1', imported = {} } = {}) {
  const version = /^const VERSION = "([0-9.]+)";$/m.exec(client?.toString('utf8') ?? '')?.[1] ?? null;
  const soulClient = client ? { contract, version, bytes: client.length, sha256: sha(client), minVersion: version } : null;
  const requests = new Map(); // code -> ask
  const counts = { requests: 0, newSouls: 0, approvals: 0, delivered: 0 };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const path = req.url.split('?')[0], body = raw ? JSON.parse(raw) : {};
      const inWorld = path.startsWith(`/w/${slug}/`) ? path.slice(`/w/${slug}`.length) : null;
      if (inWorld === '/v1/bootstrap') return json(res, 200, { world: slug, directory: '/', gateway: `/w/${slug}/v2/ws` });
      if (inWorld === '/v1/config') return json(res, 200, { ok: true, ...(soulClient ? { soulClient } : {}) });
      if (inWorld === '/eden.mjs' && client) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(client); }
      if (inWorld && /^\/v1\/(edge|agent)\//.test(inWorld)) {
        const have = req.headers['x-soul-client'] ?? '2.32.0';
        if (soulClient && /^[0-9]+(\.[0-9]+)*$/.test(have) && newer(soulClient.minVersion, have)) return json(res, 426, UPGRADE_REQUIRED(soulClient.minVersion, have));
        return json(res, 200, { ok: true });
      }
      if (path === '/v1/pair/request') {
        counts.requests++;
        if (body.new === true) counts.newSouls++;
        const code = randomBytes(4).toString('hex').toUpperCase();
        requests.set(code, { ...body, state: 'pending' });
        return json(res, 200, { code, link: `${origin()}/pair?code=${code}`, interval: 0.05 });
      }
      if (path === '/v1/pair/poll') {
        const [code, ask] = [...requests].find(([, a]) => sha(Buffer.from(String(body.secret))) === a.secret_hash) ?? [];
        if (!ask) return json(res, 200, { refused: 'unknown-secret' });
        if (ask.state === 'pending') return json(res, 200, { pending: 'authorization_pending' });
        if (ask.state === 'delivered') return json(res, 200, { refused: 'already-delivered' });
        if (ask.state !== 'approved') return json(res, 200, { refused: ask.state });
        requests.set(code, { ...ask, state: 'delivered' });
        counts.delivered++;
        return json(res, 200, { token: `${ask.grant}.${randomBytes(32).toString('hex')}`, grant: ask.grant, former: ask.former });
      }
      json(res, 404, { ok: false, code: 'not-found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin()}/w/${slug}`, origin: origin(), counts, requests,
    /** The signed-in owner approves a code: the Soul X11 brought over for its former id, if the account owns it. */
    approve(code, account) {
      const ask = requests.get(code);
      if (!ask || ask.state !== 'pending') return { refused: 'unknown-code' };
      const soul = imported[ask.world]?.[ask.former];
      if (!soul || soul.account !== account) { requests.set(code, { ...ask, state: 'unknown-soul' }); return { refused: 'unknown-soul' }; }
      counts.approvals++;
      requests.set(code, { ...ask, state: 'approved', grant: soul.grant });
      return { approved: true, soul: soul.grant };
    },
    close() { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

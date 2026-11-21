// O23b: reuse the directory's existing provider-session authority. No JWTs, account database, or tokens are cached here.
import { request } from 'node:http';

const LIMIT = 4096, TIMEOUT = 3000;
function settings(env, pub) {
  const owners = String(env.SIM_SITE_OWNERS || env.CATALOG_GENE_OWNER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!pub?.clerkPublishableKey.startsWith('pk_live_') || !owners.length || owners.some(s => !/^acct_[A-Za-z0-9-]{1,128}$/.test(s))) return null;
  try {
    const upstream = new URL(env.SOULS_OPS_DIRECTORY), origin = new URL(env.SOULS_OPS_PUBLIC_ORIGIN);
    if (upstream.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(upstream.hostname) || upstream.origin !== env.SOULS_OPS_DIRECTORY) return null;
    if (origin.origin !== env.SOULS_OPS_PUBLIC_ORIGIN || origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)))) return null;
    if (!String(env.CLERK_AUTHORIZED_PARTIES || '').split(',').map(s => s.trim()).includes(origin.origin)) return null;
    return { owners, upstream, origin: origin.origin };
  } catch { return null; }
}
function bearer(req) {
  if (req.headers.authorization !== undefined) {
    const value = req.headers.authorization;
    return typeof value === 'string' && /^Bearer [^\s,]+$/.test(value) ? value.slice(7) : null;
  }
  const values = String(req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith('__session='));
  return values.length === 1 ? values[0].slice('__session='.length) : null;
}

/** Status only: a private upstream reply and account id never become public output. */
export function ownerAuth(env, pub) {
  let active = 0;
  return async req => {
    const cfg = settings(env, pub());
    if (!cfg) return 503;
    const token = bearer(req);
    if (!token || token.length > 32768 || /[\s,]/.test(token)) return 401;
    if (active >= 2) return 429;
    active++;
    try {
      return await new Promise(resolve => {
        let done = false, timer;
        const finish = status => {
          if (done) return;
          done = true; clearTimeout(timer); req.off('aborted', aborted); resolve(status);
        };
        const upstream = request(new URL('/v1/account/session', cfg.upstream), {
          method: 'POST', headers: { authorization: `Bearer ${token}`, origin: cfg.origin, 'content-length': '0' },
        }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > LIMIT) { finish(503); upstream.destroy(); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('error', () => finish(503));
          response.on('end', () => {
            if (done) return;
            if (response.statusCode === 401) return finish(401);
            if (response.statusCode !== 200) return finish(503);
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (typeof value.account !== 'string' || !/^acct_[A-Za-z0-9-]{1,128}$/.test(value.account)) return finish(503);
              finish(cfg.owners.includes(value.account) ? 200 : 403);
            } catch { finish(503); }
          });
        });
        const aborted = () => { finish(503); upstream.destroy(); };
        req.once('aborted', aborted);
        upstream.on('error', () => finish(503));
        timer = setTimeout(aborted, TIMEOUT);
        upstream.end();
      });
    } catch { return 503; }
    finally { active--; }
  };
}

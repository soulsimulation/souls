// #2839 A: the launcher's own Clerk session check, importing nothing from apps/server. It does what the old world
// server's Auth (apps/server/src/auth.ts init + clerkUser + accountFromToken) did for verify-creator.mjs:
//   - settings: the issuer is an exact https origin, the publishable key is pk_live_ and names the issuer's host, every
//     authorized party is an exact origin (https, or http on loopback) and the registry path is absolute;
//   - the token: a compact JWS, alg RS256 only, signed by a key in the issuer's JWKS (`<issuer>/.well-known/jwks.json`);
//     iss is the issuer exactly; sub, sid, azp, exp, iat and nbf are present; sub is user_…, sid is sess_…, azp is an
//     authorized party; nbf <= now < exp (no clock tolerance, as before);
//   - the account: the shared registry binds (issuer, sub) to one acct_ id, creating it once.
// Anything it cannot check is a refusal (null): a bad setting, a JWKS it cannot fetch or read, an unknown key after one
// refetch. It never logs or returns the token.
import { createPublicKey, verify as rsaVerify, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_TOKEN = 32768, JWKS_TIMEOUT_MS = 5000, JWKS_MAX_BYTES = 64 << 10, REFETCH_COOLDOWN_MS = 30_000, JWKS_MAX_AGE_MS = 600_000;
const SUB = /^user_[A-Za-z0-9]{1,128}$/, SID = /^sess_[A-Za-z0-9]{1,128}$/, B64URL = /^[A-Za-z0-9_-]+$/;

/** The settings check of the old Auth.init for Clerk; returns a reason string, or null when they are good. */
export function settingsProblem({ issuer, publishableKey, parties, registryPath, publicUrl }) {
  let u; try { u = new URL(issuer); } catch { return 'issuer'; }
  let domain = ''; try { domain = Buffer.from(String(publishableKey).split('_').slice(2).join('_'), 'base64').toString().replace(/\$$/, ''); } catch {}
  if (u.protocol !== 'https:' || u.origin !== issuer || domain !== u.hostname || !String(publishableKey).startsWith('pk_live_')) return 'issuer-or-key';
  if (typeof registryPath !== 'string' || !isAbsolute(registryPath) || !Array.isArray(parties) || !parties.length) return 'registry-or-parties';
  let pub; try { pub = new URL(publicUrl).origin; } catch { return 'public-url'; }
  if (!parties.includes(pub)) return 'public-url';
  for (const party of parties) {
    let p; try { p = new URL(party); } catch { return 'party'; }
    if (p.origin !== party || p.username || p.password || !['https:', 'http:'].includes(p.protocol) || (p.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(p.hostname))) return 'party';
  }
  return null;
}

const part = (s) => { if (!B64URL.test(s)) throw Error('b64'); return Buffer.from(s, 'base64url'); };

/** The issuer's signing keys by kid, fetched when missing, refetched at most once per cooldown for an unknown kid
 *  (key rotation) and when older than JWKS_MAX_AGE_MS. A failed fetch leaves no keys: every check fails closed. */
export function remoteKeys(issuer, { fetch: get = globalThis.fetch, now = Date.now } = {}) {
  const url = new URL('/.well-known/jwks.json', issuer).href;
  let keys = null, at = -Infinity, tried = -Infinity, pending = null;
  const load = async () => {
    tried = now();
    try {
      const res = await get(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS), redirect: 'error' });
      if (!res.ok) throw Error('status');
      const text = await res.text();
      if (text.length > JWKS_MAX_BYTES) throw Error('size');
      const out = new Map();
      for (const k of JSON.parse(text).keys ?? []) {
        if (!k || k.kty !== 'RSA' || typeof k.kid !== 'string' || (k.alg !== undefined && k.alg !== 'RS256') || (k.use !== undefined && k.use !== 'sig')) continue;
        try { out.set(k.kid, createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' })); } catch {}
      }
      keys = out; at = now();
    } catch { keys = null; at = -Infinity; }
  };
  const once = () => (pending ??= load().finally(() => { pending = null; }));
  return async (kid) => {
    if (!keys || now() - at > JWKS_MAX_AGE_MS) await once();
    if (keys && !keys.has(kid) && now() - tried >= REFETCH_COOLDOWN_MS) await once();
    return keys?.get(kid) ?? null;
  };
}

/** The verified claims of a Clerk session token, or null. `key(kid)` resolves a public key (remoteKeys). */
export async function verifiedClaims(token, { issuer, parties, key, now = Date.now }) {
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
    const segs = token.split('.');
    if (segs.length !== 3) return null;
    const header = JSON.parse(part(segs[0]).toString('utf8')), payload = JSON.parse(part(segs[1]).toString('utf8')), sig = part(segs[2]);
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const pub = await key(header.kid);
    if (!pub || !rsaVerify('sha256', Buffer.from(`${segs[0]}.${segs[1]}`), pub, sig)) return null;
    const t = Math.floor(now() / 1000);
    const { iss, sub, sid, azp, exp, iat, nbf } = payload;
    if (iss !== issuer || typeof sub !== 'string' || !SUB.test(sub) || typeof sid !== 'string' || !SID.test(sid)) return null;
    if (typeof azp !== 'string' || !parties.includes(azp)) return null;
    if (!Number.isSafeInteger(exp) || typeof iat !== 'number' || !Number.isFinite(iat) || typeof nbf !== 'number' || !Number.isFinite(nbf)) return null;
    if (t >= exp || nbf > t) return null;
    return { sub, sid, azp, exp };
  } catch { return null; }
}

/** The shared account registry (the old server's AccountRegistry, the same table and rules): identity only. */
export function bindAccount(registryPath, issuer, subject) {
  if (registryPath !== ':memory:') mkdirSync(dirname(resolve(registryPath)), { recursive: true });
  const db = new DatabaseSync(registryPath);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS provider_accounts_v1(account_id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(issuer,subject))');
    const find = () => db.prepare('SELECT account_id FROM provider_accounts_v1 WHERE issuer=? AND subject=?').get(issuer, subject);
    const hit = find(); if (hit) return hit.account_id;
    db.exec('BEGIN IMMEDIATE');
    try {
      let row = find();
      if (!row) { row = { account_id: 'acct_' + randomUUID() }; db.prepare('INSERT INTO provider_accounts_v1 VALUES(?,?,?,?)').run(row.account_id, issuer, subject, Date.now()); }
      db.exec('COMMIT'); return row.account_id;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
}

/** The account id a Clerk session token proves, or null. */
export async function verifiedAccount(token, settings, { fetch, now } = {}) {
  if (settingsProblem(settings)) return null;
  const claims = await verifiedClaims(token, { issuer: settings.issuer, parties: settings.parties, key: settings.key ?? remoteKeys(settings.issuer, { fetch, now }), now });
  return claims ? bindAccount(settings.registryPath, settings.issuer, claims.sub) : null;
}

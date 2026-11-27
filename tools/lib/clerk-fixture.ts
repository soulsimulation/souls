// Synthetic Clerk for tests: an RS256 key pair, a JWKS served by a stubbed fetch
// for one fixed https issuer, and session tokens signed like Clerk's (sub, sid,
// azp, iat, nbf, exp). No network, no provider keys, never used outside tests.
// Moved from apps/server/test (#2839) and signed with node:crypto, so it needs no package.
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';

export const ISSUER = 'https://clerk.example.test';
export const ORIGIN = 'https://sim.example.test';
/** A live-shaped publishable key whose encoded domain matches ISSUER (what Auth.init checks). */
export const PUBLISHABLE_KEY = 'pk_live_' + Buffer.from('clerk.example.test$').toString('base64');

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

export async function clerkKeys(origin = ORIGIN, kid = 'fixture') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { kty, n, e } = publicKey.export({ format: 'jwk' });
  const jwk = { kty, n, e, kid, alg: 'RS256' };
  /** A Clerk-shaped session token for `sub` (override any claim with `extra`, the issuer with `iss`). */
  const sign = async (sub = 'user_alice', extra: Record<string, unknown> = {}, iss = ISSUER) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { sid: 'sess_fixture', azp: origin, ...extra, sub, iss, iat: now, nbf: now, exp: typeof extra.exp === 'number' ? extra.exp : now + 60 };
    const input = `${b64url({ alg: 'RS256', kid })}.${b64url(claims)}`;
    return `${input}.${rsaSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
  };
  return { jwk, sign };
}

/** Serve `jwk` at ISSUER's JWKS URL; anything else goes to the real fetch. Returns the restore function. */
export function stubJwks(jwk: object, issuer = ISSUER) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input instanceof Request ? input.url : input) === issuer + '/.well-known/jwks.json'
      ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
      : original(input, init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

/** The Config fields that select Clerk (production sign-in) for a world at ORIGIN. */
export const clerkSettings = (registryPath: string, worldPath = '/w/hello', origin = ORIGIN) => ({
  authProvider: 'clerk' as const, accountAuthRequired: true, clerkIssuer: ISSUER, clerkPublishableKey: PUBLISHABLE_KEY,
  clerkAuthorizedParties: [origin], publicUrl: origin + worldPath, accountRegistryPath: registryPath,
  privyAppId: '', privyAppSecret: '',
});

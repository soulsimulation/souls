// node --test tools/world-launcher/clerk-session.test.mjs
// #2839 A: the launcher's own Clerk session check. A good token gives its account; expired, not yet valid, wrong
// issuer, wrong authorized party (Clerk's audience), tampered, re-signed, unsigned and malformed tokens give null; a
// rotated key is fetched once; a JWKS that cannot be fetched or read fails closed. No network: fetch is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clerkKeys, ISSUER, ORIGIN, PUBLISHABLE_KEY } from '../lib/clerk-fixture.ts';
import { bindAccount, remoteKeys, settingsProblem, verifiedAccount, verifiedClaims } from './clerk-session.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clerk-session-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const settings = (over = {}) => ({ issuer: ISSUER, publishableKey: PUBLISHABLE_KEY, parties: [ORIGIN], registryPath: join(dir, 'accounts.sqlite'), publicUrl: ORIGIN + '/', ...over });
/** A fetch that serves `sets()` at the issuer's JWKS URL and counts calls; anything else is refused. */
const jwksFetch = (sets) => { const f = async (url) => { f.calls++; if (url !== ISSUER + '/.well-known/jwks.json') throw Error('unexpected ' + url); const s = sets(); return s instanceof Response ? s : new Response(JSON.stringify({ keys: s })); }; f.calls = 0; return f; };
const flip = (s) => s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);

test('a good token gives one stable acct_ id, and the same subject the same id', async () => {
  const k = await clerkKeys();
  const a = await verifiedAccount(await k.sign('user_alice'), settings(), { fetch: jwksFetch(() => [k.jwk]) });
  assert.match(a, /^acct_[0-9a-f-]{36}$/);
  assert.equal(await verifiedAccount(await k.sign('user_alice'), settings(), { fetch: jwksFetch(() => [k.jwk]) }), a);
  assert.notEqual(await verifiedAccount(await k.sign('user_bob'), settings(), { fetch: jwksFetch(() => [k.jwk]) }), a);
  assert.equal(bindAccount(settings().registryPath, ISSUER, 'user_alice'), a);
});

test('expired, not yet valid, wrong issuer and wrong authorized party are refused', async () => {
  const k = await clerkKeys(), fetch = jwksFetch(() => [k.jwk]), now = Math.floor(Date.now() / 1000);
  const v = (t) => verifiedAccount(t, settings(), { fetch });
  assert.equal(await v(await k.sign('user_alice', { exp: now - 1 })), null, 'expired');
  assert.equal(await v(await k.sign('user_alice', { exp: now })), null, 'expires this second');
  assert.equal(await v(await k.sign('user_alice', {}, 'https://other.example.test')), null, 'issuer');
  assert.equal(await v(await k.sign('user_alice', {}, ISSUER + '/')), null, 'issuer with a slash');
  const other = await clerkKeys('https://evil.example.test');
  const fetch2 = jwksFetch(() => [other.jwk]);
  assert.equal(await verifiedAccount(await other.sign('user_alice'), settings(), { fetch: fetch2 }), null, 'azp not an authorized party');
  // nbf in the future: the fixture sets nbf=now, so a later clock is the only way to move it; here the clock is earlier
  assert.equal(await verifiedAccount(await k.sign('user_alice'), settings(), { fetch, now: () => Date.now() - 5000 }), null, 'not yet valid');
});

test('missing or malformed claims are refused', async () => {
  const k = await clerkKeys(), fetch = jwksFetch(() => [k.jwk]);
  const v = (t) => verifiedAccount(t, settings(), { fetch });
  assert.equal(await v(await k.sign('alice')), null, 'sub not user_');
  assert.equal(await v(await k.sign('user_alice', { sid: 'nope' })), null, 'sid');
  assert.equal(await v(await k.sign('user_alice', { azp: undefined })), null, 'no azp');
  assert.equal(await v(await k.sign('user_alice', { exp: 1e20 })), null, 'exp not a safe integer');
});

test('tampered, re-signed, unsigned and malformed tokens are refused', async () => {
  const k = await clerkKeys(), fetch = jwksFetch(() => [k.jwk]);
  const v = (t) => verifiedAccount(t, settings(), { fetch });
  const good = await k.sign('user_alice');
  const [h, p, s] = good.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'user_mallory' })).toString('base64url');
  assert.equal(await v(`${h}.${forged}.${s}`), null, 'payload changed');
  assert.equal(await v(`${h}.${p}.${flip(s)}`), null, 'signature changed');
  const attacker = await clerkKeys(ORIGIN, 'fixture');
  assert.equal(await v(await attacker.sign('user_alice')), null, 'signed by another key under the same kid');
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'fixture' })).toString('base64url');
  assert.equal(await v(`${none}.${p}.`), null, 'alg none');
  const hs = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'fixture' })).toString('base64url');
  assert.equal(await v(`${hs}.${p}.${s}`), null, 'alg HS256');
  for (const bad of ['', 'a.b', 'a.b.c.d', `${h}.${p}`, `${h}!.${p}.${s}`, 'x'.repeat(40000)]) assert.equal(await v(bad), null, bad.slice(0, 20));
  assert.equal(await v(undefined), null);
});

test('JWKS rotation: an unknown kid refetches once, then is refused until the cooldown', async () => {
  const k1 = await clerkKeys(ORIGIN, 'one'), k2 = await clerkKeys(ORIGIN, 'two');
  let served = [k1.jwk], t = Date.now();
  const fetch = jwksFetch(() => served), key = remoteKeys(ISSUER, { fetch, now: () => t });
  const v = async (tok) => verifiedClaims(tok, { issuer: ISSUER, parties: [ORIGIN], key });
  assert.ok(await v(await k1.sign('user_alice')));
  assert.equal(fetch.calls, 1);
  assert.ok(await v(await k1.sign('user_alice')));
  assert.equal(fetch.calls, 1, 'a known kid is served from the cache');
  served = [k1.jwk, k2.jwk]; t += 31_000;
  assert.ok(await v(await k2.sign('user_alice')), 'the rotated key is fetched');
  assert.equal(fetch.calls, 2);
  const k3 = await clerkKeys(ORIGIN, 'three');
  assert.equal(await v(await k3.sign('user_alice')), null, 'a kid the issuer does not publish');
  assert.equal(fetch.calls, 2, 'within the cooldown, no refetch for it');
});

test('a JWKS that cannot be fetched or read fails closed', async () => {
  const k = await clerkKeys(), tok = await k.sign('user_alice');
  const cases = {
    'network error': async () => { throw Error('down'); },
    'status 500': async () => new Response('no', { status: 500 }),
    'not JSON': async () => new Response('<html>'),
    'no keys': async () => new Response('{}'),
    'too large': async () => new Response(JSON.stringify({ keys: [k.jwk], pad: 'x'.repeat(70000) })),
    'wrong key type': async () => new Response(JSON.stringify({ keys: [{ ...k.jwk, kty: 'EC' }] })),
  };
  for (const [name, fetch] of Object.entries(cases)) assert.equal(await verifiedAccount(tok, settings(), { fetch }), null, name);
});

test('the old settings checks: an issuer or key that do not match, or a party that is not an exact origin, refuse every token', async () => {
  assert.equal(settingsProblem(settings()), null);
  assert.ok(settingsProblem(settings({ publishableKey: 'pk_test_' + Buffer.from('clerk.example.test$').toString('base64') })));
  assert.ok(settingsProblem(settings({ publishableKey: 'pk_live_' + Buffer.from('other.example.test$').toString('base64') })));
  assert.ok(settingsProblem(settings({ issuer: 'http://clerk.example.test' })));
  assert.ok(settingsProblem(settings({ parties: [] })));
  assert.ok(settingsProblem(settings({ parties: [ORIGIN, 'http://example.test'] })));
  assert.ok(settingsProblem(settings({ parties: [ORIGIN + '/'] })));
  assert.ok(settingsProblem(settings({ publicUrl: 'https://elsewhere.example.test/' })));
  assert.ok(settingsProblem(settings({ registryPath: 'accounts.sqlite' })));
  const k = await clerkKeys();
  assert.equal(await verifiedAccount(await k.sign('user_alice'), settings({ publishableKey: 'pk_test_x' }), { fetch: jwksFetch(() => [k.jwk]) }), null);
});

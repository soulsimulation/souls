// node --test tools/world-launcher/creator-auth.test.mjs
// #2839 A: the creator check as the launcher runs it (a child per check, the Clerk env file by path, the token on
// stdin), through the launcher's own verify-session.mjs and, with the switch file set to `old`, through the old
// verify-creator.mjs. Both give the same account for the same session and refuse the same bad ones; with the JWKS
// unavailable the new check refuses (fails closed). A synthetic issuer and the test-only JWKS preload: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creatorVerifier, verifiedCreator } from './creator-auth.mjs';
import { clerkKeys, ISSUER, PUBLISHABLE_KEY } from '../lib/clerk-fixture.ts';

const root = new URL('../../', import.meta.url).pathname;
const preload = new URL('../lib/clerk-jwks-preload.mjs', import.meta.url).pathname;
const ORIGIN = 'https://sim.example.test';
const dir = mkdtempSync(join(tmpdir(), 'creator-auth-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const keys = await clerkKeys(ORIGIN);
const jwks = join(dir, 'jwks.json');
writeFileSync(jwks, JSON.stringify({ keys: [keys.jwk] }));
const envFile = join(dir, 'clerk.env');
writeFileSync(envFile, [`CLERK_PUBLISHABLE_KEY=${PUBLISHABLE_KEY}`, `CLERK_ISSUER_URL=${ISSUER}`, `CLERK_AUTHORIZED_PARTIES=${ORIGIN}`,
  `SIM_TEST_JWKS_FILE=${jwks}`, `NODE_OPTIONS=--import=${preload}`, ''].join('\n'));
const auth = { envFile, registryPath: join(dir, 'accounts.sqlite'), verifierSwitch: join(dir, 'creator-verifier') };
const check = (token) => verifiedCreator(token === undefined ? undefined : `Bearer ${token}`, auth, ORIGIN + '/', root);
const setSwitch = (mode) => { if (mode) writeFileSync(auth.verifierSwitch, mode + '\n'); else try { unlinkSync(auth.verifierSwitch); } catch {} };

test('the switch: the launcher\'s own check unless the file says old; read on every check', () => {
  setSwitch(null); assert.equal(creatorVerifier(auth), 'tools/world-launcher/verify-session.mjs');
  setSwitch('old'); assert.equal(creatorVerifier(auth), 'tools/world-launcher/verify-creator.mjs');
  setSwitch('new'); assert.equal(creatorVerifier(auth), 'tools/world-launcher/verify-session.mjs');
  assert.equal(creatorVerifier({}), 'tools/world-launcher/verify-session.mjs');
  setSwitch(null);
});

test('new and old checks agree: the same account for a good session, null for bad ones', async () => {
  const now = Math.floor(Date.now() / 1000), good = await keys.sign('user_alice');
  const bad = {
    expired: await keys.sign('user_alice', { exp: now - 1 }),
    'wrong issuer': await keys.sign('user_alice', {}, 'https://other.example.test'),
    'wrong authorized party': await keys.sign('user_alice', { azp: 'https://evil.example.test' }),
    tampered: (() => { const [h, p, s] = good.split('.'); const c = JSON.parse(Buffer.from(p, 'base64url')); return `${h}.${Buffer.from(JSON.stringify({ ...c, sub: 'user_mallory' })).toString('base64url')}.${s}`; })(),
    'another key': await (await clerkKeys(ORIGIN)).sign('user_alice'),
  };
  const results = {};
  for (const mode of [null, 'old']) {
    setSwitch(mode);
    const id = await check(good);
    assert.match(id, /^acct_/, `${mode ?? 'new'}: a good session`);
    results[mode ?? 'new'] = id;
    for (const [name, t] of Object.entries(bad)) assert.equal(await check(t), null, `${mode ?? 'new'}: ${name}`);
    assert.equal(await check(undefined), null);
  }
  assert.equal(results.new, results.old, 'both bind the same registry row');
  setSwitch(null);
});

test('the JWKS unavailable: the new check fails closed', async () => {
  setSwitch(null);
  const good = await keys.sign('user_bob');
  writeFileSync(jwks, 'not json');
  assert.equal(await check(good), null, 'unreadable JWKS');
  writeFileSync(jwks, JSON.stringify({ keys: [] }));
  assert.equal(await check(good), null, 'no keys');
  writeFileSync(jwks, JSON.stringify({ keys: [keys.jwk] }));
  assert.match(await check(good), /^acct_/, 'and back');
});

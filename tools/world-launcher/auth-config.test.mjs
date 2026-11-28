// B3-2c: the site's public sign-in fields at /v1/auth/config, so the pairing card (`/pair`, the directory's) signs in
// with the session the old page already holds and approves with it as a bearer, the token the directory verifies
// (v2/crates/directoryd: RS256 against --issuer, azp among --parties). Dev auth has none: the card's local test sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { ISSUER, PUBLISHABLE_KEY } from '../lib/clerk-fixture.ts';
import { testPort } from '../lib/test-port.ts';

const scratch = new URL('../../.local/', import.meta.url).pathname;
mkdirSync(scratch, { recursive: true });
const config = async (base, host) => {
  const r = await fetch(`${base}/v1/auth/config`, host ? { headers: { host } } : {});
  return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
};

test('the site\'s own provider fields, as the pairing card reads them; none under dev auth', async (t) => {
  const dir = mkdtempSync(join(scratch, 'b3-2c-')), env = join(dir, 'clerk.env');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const P = await testPort(6), origin = `http://localhost:${P}`;
  writeFileSync(env, [`CLERK_PUBLISHABLE_KEY=${PUBLISHABLE_KEY}`, `CLERK_ISSUER_URL=${ISSUER}`, `CLERK_AUTHORIZED_PARTIES=${origin}`, 'SOME_SECRET=never-served', ''].join('\n'));
  const clerk = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: join(dir, 'clerk'), authEnvFile: env, publicOrigin: origin, eager: 0, log: () => {} });
  const dev = await openLauncher({ port: P + 3, range: [P + 4, P + 5], dataDir: join(dir, 'dev'), devAuth: true, eager: 0, log: () => {} });
  t.after(async () => { await clerk.close(); await dev.close(); });

  const got = await config(`http://127.0.0.1:${P}`);
  assert.equal(got.status, 200);
  assert.equal(got.cache, 'no-store');
  assert.deepEqual(got.body, { authProvider: 'clerk', clerkPublishableKey: PUBLISHABLE_KEY, clerkIssuer: ISSUER }, 'the public fields only, never another line of the file');
  // what the card checks before it loads the provider (v2/web/src/source/signin.ts providerScript): clerk, a key whose
  // encoded host is the provider's Frontend API, and an https issuer
  const api = Buffer.from(got.body.clerkPublishableKey.replace(/^pk_(live|test)_/, ''), 'base64').toString().replace(/\$$/, '');
  assert.equal(`https://${api}`, got.body.clerkIssuer);

  const none = await config(`http://127.0.0.1:${P + 3}`);
  assert.deepEqual([none.status, none.body.code], [503, 'auth-unconfigured'], 'dev auth: no provider, so the card offers its local test sign-in');
});

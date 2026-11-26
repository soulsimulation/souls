// Trial of 0.137: the /pair card's first look signs in from an existing provider session without a click, and when signed
// out it opens nothing (the Sign in button stays). The helper is v2/web/src/source/signin.test.ts's page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type PageEnv, type Provider, providerSession } from '../src/pairing/signin.ts';

const HOST = 'example-app.clerk.accounts.dev';
const KEY = `pk_test_${btoa(`${HOST}$`)}`;
const CFG = { authProvider: 'clerk', clerkPublishableKey: KEY, clerkIssuer: `https://${HOST}` };
const PAGE = 'https://world.example.test/pair?code=BCDF-GHJK';

function page(provider: Provider): PageEnv {
  const global: { Clerk?: Provider } = {};
  return {
    href: PAGE, global, navigate: () => assert.fail('a silent look never navigates'),
    document: {
      createElement: () => {
        const on: Record<string, () => void> = {};
        return { src: '', setAttribute: () => {}, addEventListener: (e: string, f: () => void) => void (on[e] = f), on } as unknown as HTMLScriptElement;
      },
      head: { appendChild: (n: any) => { setTimeout(() => ((global.Clerk = provider), n.on.load()), 0); } },
    },
  };
}

test('trial of 0.137: a silent look is signed in from an existing session, and opens no sign-in when signed out', async () => {
  let opened = 0;
  const signedIn: Provider = { load: async () => {}, session: { id: 'sess', getToken: async () => 'tok' }, user: { id: 'u' },
    openSignIn: () => void opened++, buildSignInUrl: () => '' };
  const s = await providerSession(CFG, page(signedIn), true);
  assert.ok(s && 'bearer' in s);
  assert.equal(await s.bearer(), 'tok');
  const signedOut: Provider = { load: async () => {}, session: null, openSignIn: () => void opened++, buildSignInUrl: () => '' };
  assert.equal(await providerSession(CFG, page(signedOut), true), null);
  assert.equal(opened, 0, 'nothing opened on the first look');
  assert.equal(await providerSession(CFG, page(signedOut)), null);
  assert.equal(opened, 1, 'Sign in still opens the provider\'s sign-in');
});

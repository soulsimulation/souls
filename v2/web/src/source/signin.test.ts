// V13c (#3418) A2: the page loads today's sign-in provider script behind today's configuration and signs in from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type PageEnv, type Provider, frontendApi, providerScript, providerSession } from './signin.ts';
import { exchange } from './socket.ts';

const HOST = 'example-app.clerk.accounts.dev';
const KEY = `pk_test_${btoa(`${HOST}$`)}`;
const CFG = { authProvider: 'clerk', clerkPublishableKey: KEY, clerkIssuer: `https://${HOST}` };
const PAGE = 'https://world.example.test/v2/?stream=s&directory=https://dir.example.test&gateway=wss://gw.example.test/v2/ws';

/** A page with no provider yet: appending the script "loads" it, which puts `provider` on the global scope. */
function page(provider: Provider) {
  const appended: { src: string; attrs: Record<string, string>; async: boolean; crossOrigin: string }[] = [];
  const navigated: string[] = [];
  const global: { Clerk?: Provider } = {};
  const env: PageEnv = {
    href: PAGE,
    global,
    navigate: (u) => void navigated.push(u),
    document: {
      createElement: () => {
        const attrs: Record<string, string> = {};
        const on: Record<string, () => void> = {};
        return { src: '', async: false, crossOrigin: '', attrs, setAttribute: (k: string, v: string) => void (attrs[k] = v),
          addEventListener: (e: string, f: () => void) => void (on[e] = f), on } as unknown as HTMLScriptElement;
      },
      head: {
        appendChild: (n: any) => {
          appended.push({ src: n.src, attrs: n.attrs, async: n.async, crossOrigin: n.crossOrigin });
          setTimeout(() => ((global.Clerk = provider), n.on.load()), 0);
        },
      },
    },
  };
  return { env, appended, navigated };
}

test('V13c A2: the provider script is the one today\'s site loads, behind the same configuration', () => {
  assert.equal(frontendApi(KEY), HOST);
  assert.deepEqual(providerScript(CFG, 'https://world.example.test'), {
    src: `https://${HOST}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`,
    attributes: { 'data-clerk-publishable-key': KEY },
  });
  // The same rule as today's site: no provider without `clerk`, its key and its issuer.
  assert.equal(providerScript({ ...CFG, authProvider: 'none' }, 'https://world.example.test'), null);
  assert.equal(providerScript({ ...CFG, clerkIssuer: undefined }, 'https://world.example.test'), null);
  assert.equal(providerScript({}, 'https://world.example.test'), null);
  // On a satellite's own origin with a live key, the script comes from the satellite's `clerk.` host.
  const live = `pk_live_${btoa('clerk.soul.example$')}`;
  const sat = { ...CFG, clerkPublishableKey: live, clerkSatellite: { domain: 'world.example.test', signInUrl: 'https://soul.example/sign-in' } };
  assert.deepEqual(providerScript(sat, 'https://world.example.test'), {
    src: 'https://clerk.world.example.test/npm/@clerk/clerk-js@5/dist/clerk.browser.js',
    attributes: { 'data-clerk-publishable-key': live, 'data-clerk-domain': 'world.example.test' },
  });
});

test('V13c A2: a signed-in owner signs in from the script: the exchange carries the provider\'s fresh token', async () => {
  let loaded: object | null = null, asked = 0;
  const provider: Provider = {
    load: async (o) => void (loaded = o ?? null),
    session: { getToken: async () => `session-${++asked}` },
    openSignIn: () => assert.fail('signed in: no sign-in opens'),
    buildSignInUrl: () => assert.fail('not a satellite'),
  };
  const { env, appended } = page(provider);
  const session = await providerSession(CFG, env);
  assert.deepEqual(appended, [{ src: `https://${HOST}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`,
    attrs: { 'data-clerk-publishable-key': KEY }, async: true, crossOrigin: 'anonymous' }]);
  assert.deepEqual(loaded, {});
  assert.ok(session && 'bearer' in session);
  // The session's token goes to the directory as the bearer, fresh each exchange; never in an address.
  const sent: { url: string; auth: string | undefined }[] = [];
  const post = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify({ token: 'view.1.g.m', expires: 1, owned: [] }), { status: 200 });
  }) as typeof fetch;
  await exchange('https://dir.example.test', session, post);
  await exchange('https://dir.example.test', session, post);
  assert.deepEqual(sent.map((s) => s.auth), ['Bearer session-1', 'Bearer session-2']);
  assert.ok(sent.every((s) => !s.url.includes('session-')));
});

test('V13c A2: signed out, the provider\'s sign-in opens and returns to this page; no config loads no script', async () => {
  let opened: unknown = null;
  const provider: Provider = {
    load: async () => {},
    session: null,
    openSignIn: (o) => void (opened = o),
    buildSignInUrl: () => assert.fail('not a satellite'),
  };
  const { env } = page(provider);
  assert.equal(await providerSession(CFG, env), null);
  assert.deepEqual(opened, { afterSignInUrl: PAGE, afterSignUpUrl: PAGE });
  const bare = page(provider);
  assert.equal(await providerSession({}, bare.env), null);
  assert.deepEqual(bare.appended, []);
});

test('W18: installed config reaches fresh provider requests for account, pairing, world creation and creator exchange', async () => {
  const { browserSession, sessionRequest } = await import('./signin.ts');
  let asked = 0;
  const provider: Provider = { load: async () => {}, session: { getToken: async () => `fresh-${++asked}` }, openSignIn() {}, buildSignInUrl: () => '' };
  const { env } = page(provider);
  const reads: { path: string; init: RequestInit }[] = [];
  const config = (async (path: string, init: RequestInit) => {
    reads.push({ path, init });
    return new Response(JSON.stringify(CFG));
  }) as typeof fetch;
  const session = await browserSession(undefined, env, config);
  assert.ok(session && 'bearer' in session);
  for (const [kind, body] of [['account', {}], ['account', { code: 'PAIR', confirm: true }], ['world', { name: 'new-world' }], ['world', {}]] as const) {
    const req = await sessionRequest(session, kind, body);
    assert.equal((req.headers as Record<string, string>).authorization, `Bearer fresh-${asked}`);
    assert.equal(req.credentials, 'omit');
    assert.equal(req.redirect, 'error');
    assert.ok(!String(req.body).includes('test_person'));
  }
  assert.equal(asked, 4);
  assert.equal(reads[0].path, '/v1/auth/config');
  assert.deepEqual(reads[0].init, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
});

test('W18: missing provider refuses usefully on public pages; local-only test fallback never replaces configured sign-in', async () => {
  const { browserSession, localTestSignIn, sessionRequest } = await import('./signin.ts');
  for (const href of ['https://world.example.test/', 'http://world.example.test/', 'https://localhost/', 'http://localhost.example.test/']) assert.equal(localTestSignIn(href), false);
  for (const href of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/']) assert.equal(localTestSignIn(href), true);
  const { env } = page({ load: async () => {}, session: null, openSignIn() {}, buildSignInUrl: () => '' });
  const missing = (async () => new Response('{}', { status: 503 })) as typeof fetch;
  await assert.rejects(browserSession('maker', env, missing), /Sign-in is not configured/);
  env.href = 'http://localhost/';
  const local = await browserSession('maker', env, missing);
  assert.deepEqual(local, { testName: 'maker' });
  assert.deepEqual(JSON.parse((await sessionRequest(local!, 'account')).body as string), { test_person: 'maker' });
  assert.equal((await sessionRequest(local!, 'world')).headers && ((await sessionRequest(local!, 'world')).headers as Record<string, string>).authorization, 'Bearer test:maker');
  const configured = (async () => new Response(JSON.stringify(CFG))) as typeof fetch;
  assert.equal(await browserSession('maker', env, configured), null);
  await assert.rejects(sessionRequest({ bearer: async () => '' }, 'account'), /Sign-in expired/);
});

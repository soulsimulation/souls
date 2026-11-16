// node --test apps/web/src/clerk-presync.test.ts — #1266 G4, #1385: a satellite syncs with Clerk before the world loads, never after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { worldClerkNow, WORLD_SIGNIN } from './auth-ui.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = /<script id="clerk-presync">([\s\S]*?)<\/script>/.exec(html)![1];
const sat = { authProvider: 'clerk', clerkSatellite: { domain: 'soul.game', signInUrl: 'https://primary.example/sign-in' } };
function visit(href: string, { config = sat as unknown, cookie = '', stored = null as string | null, now = 1_000_000, store = new Map<string, string>(), asked = null as number | null } = {}) {
  if (stored) store.set('soul.clerk-presync', stored);
  if (asked !== null) store.set(WORLD_SIGNIN, JSON.stringify({ t: asked, sent: false }));
  const u = new URL(href); let went: string | null = null;
  vm.runInNewContext(code, { window: { __simConfig: config }, document: { cookie }, Date: { now: () => now },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    location: { href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, replace: (to: string) => { went = to; } }, encodeURIComponent });
  return went;
}

// #2516: only a page that will load Clerk syncs; the cases below use a sign-in step (#join) unless they say otherwise.
const J = '#join', JE = '%23join';
test('#2516: an anonymous first visit never syncs and never calls the provider', () => {
  for (const href of ['https://soul.game/w/eden/', 'https://soul.game/w/eden/#watch', 'https://soul.game/w/eden/#soul/s_Avery'])
    assert.equal(visit(href), null, href);
  assert.equal(visit('https://soul.game/w/eden/#watch', { cookie: '__client_uat=0' }), null, 'signed out by Clerk itself');
  assert.equal(visit('https://soul.game/w/eden/#watch', { asked: 1_000_000 - 11 * 60_000 }), null, 'an old ask has lapsed');
});

test('#2516: a page that will load Clerk (a sign-in step, an ask on this tab) syncs first and comes back to the same address', () => {
  assert.equal(visit('https://soul.game/w/eden/#approve/AB12'), 'https://clerk.soul.game/v1/client/sync?redirect_url=https%3A%2F%2Fsoul.game%2Fw%2Feden%2F%23approve%2FAB12', 'a pairing link');
  assert.equal(visit('https://soul.game/w/eden/#watch', { asked: 1_000_000 - 60_000 }), 'https://clerk.soul.game/v1/client/sync?redirect_url=https%3A%2F%2Fsoul.game%2Fw%2Feden%2F%23watch', 'Sign in clicked a minute ago');
});

test('#2516: the presync and ClerkWorld use one rule (auth-ui.ts worldClerkNow)', () => {
  // cookies Clerk would sync with (signed out; the suffixed one wins), so the presync leaves exactly when the rule says
  const now = 1_000_000, cookies = ['', '__client_uat=0', '__client_uat=1760000000; __client_uat_Xy12=0'];
  const hashes = ['', '#', '#watch', '#soul/s_Avery', '#soul/%20bad', '#join', '#approve/AB12', '#godpair/ABCD-EFGH', '#my%20soul', '#pair/ABCD-EFGH'];
  const queries = ['', '?__clerk_handshake=x', '?__session=x', '?__dev_session=x', '?x=1'];
  for (const q of queries) for (const h of hashes) for (const cookie of cookies) for (const asked of [null, now - 60_000, now - 11 * 60_000]) {
    const href = 'https://soul.game/w/eden/' + q + h;
    assert.equal(visit(href, { cookie, asked }) !== null, worldClerkNow(href, h, cookie, asked, now), `${href} ${cookie} ${asked}`);
  }
});

test('it never syncs twice, and leaves everything else alone', () => {
  assert.equal(visit('https://soul.game/w/eden/?__clerk_synced=true'+J), null, 'back from the sync');
  assert.equal(visit('https://soul.game/w/eden/'+J, { cookie: '__client_uat_Xy12=1760000000' }), null, 'signed in (suffixed cookie)');
  assert.equal(visit('https://soul.game/w/eden/'+J, { cookie: 'a=1; __client_uat=1760000000' }), null, 'signed in (plain cookie)');
  assert.equal(visit('https://soul.game/w/eden/'+J, { stored: String(1_000_000 - 5000) }), null, 'tried a moment ago: a blocked cookie never loops');
  assert.notEqual(visit('https://soul.game/w/eden/'+J, { stored: String(1_000_000 - 120_000) }), null, 'a minute later, it may try again');
  assert.equal(visit('https://soul.game/w/eden/?shot=1'+J), null, 'a picture page');
  assert.equal(visit('https://soul.game/'+J), null, 'not a world page');
  assert.equal(visit('https://soul.game/w/eden/'+J, { config: { authProvider: 'clerk' } }), null, 'the primary domain itself');
  assert.equal(visit('https://soul.game/w/eden/'+J, { config: { authProvider: 'dev' } }), null, 'a dev world');
  assert.equal(visit('https://soul.game/w/eden/'+J, { config: { ...sat, clerkSatellite: { domain: 'evil.example/x?' } } }), null, 'a strange domain');
});

test('only on the satellite\'s own origin: a preview host or local dev never leaves for the sync', () => {
  assert.notEqual(visit('https://soul.game/w/eden/'+J), null, 'the satellite itself');
  assert.equal(visit('https://preview-123.soul.game/w/eden/'+J), null, 'a preview host');
  assert.equal(visit('http://127.0.0.1:4710/w/eden/'+J), null, 'local dev');
  assert.equal(visit('http://soul.game/w/eden/'+J), null, 'not https');

});

// #1385: Clerk JS 5 syncs a satellite on load whenever the "client updated at" cookie is missing or not above 0, so a
// signed-out visit that skipped this left the page about 13 s in (after the arrival card) and booted the world twice.
test('a signed-out visit (cookie 0) syncs before the world loads, as Clerk would after it', () => {
  const to = 'https://clerk.soul.game/v1/client/sync?redirect_url=https%3A%2F%2Fsoul.game%2Fw%2Feden%2F' + JE;
  assert.equal(visit('https://soul.game/w/eden/'+J), to, 'cookie absent');
  assert.equal(visit('https://soul.game/w/eden/'+J, { cookie: 'a=1; __client_uat=0' }), to, 'cookie 0');
  assert.equal(visit('https://soul.game/w/eden/'+J, { cookie: '__client_uat=0; __client_uat_Xy12=0' }), to, 'both cookies 0');
  assert.equal(visit('https://soul.game/w/eden/'+J, { cookie: '__client_uat=1760000000; __client_uat_Xy12=0' }), to, 'the suffixed cookie wins, as in Clerk');
  assert.equal(visit('https://soul.game/w/eden/'+J, { cookie: '__client_uat=0; __client_uat_Xy12=1760000000' }), null, 'signed in by the suffixed cookie');
});

test('no loop: back from the sync it loads once, and a later signed-out visit may sync again', () => {
  const store = new Map<string, string>(), cookie = '__client_uat=0; __client_uat_Xy12=0';
  assert.notEqual(visit('https://soul.game/w/eden/'+J, { cookie, store }), null, 'leaves for the sync');
  assert.equal(visit('https://soul.game/w/eden/?__clerk_synced=true'+J, { cookie, store, now: 1_000_500 }), null, 'back from it: stays');
  assert.equal(store.has('soul.clerk-presync'), false, 'a sync that came back clears the minute guard');
  assert.notEqual(visit('https://soul.game/w/eden/'+J, { cookie, store, now: 1_010_000 }), null, 'a reload ten seconds later syncs first again, before the world loads');
  const lost = new Map<string, string>();
  assert.notEqual(visit('https://soul.game/w/eden/'+J, { cookie, store: lost }), null);
  assert.equal(visit('https://soul.game/w/eden/'+J, { cookie, store: lost, now: 1_000_500 }), null, 'a sync that came back without its marker never loops');
});

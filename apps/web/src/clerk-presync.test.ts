// node --test apps/web/src/clerk-presync.test.ts — #1266 G4, #1385: a satellite syncs with Clerk before the world loads, never after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = /<script id="clerk-presync">([\s\S]*?)<\/script>/.exec(html)![1];
const sat = { authProvider: 'clerk', clerkSatellite: { domain: 'soul.game', signInUrl: 'https://primary.example/sign-in' } };
function visit(href: string, { config = sat as unknown, cookie = '', stored = null as string | null, now = 1_000_000, store = new Map<string, string>() } = {}) {
  if (stored) store.set('soul.clerk-presync', stored);
  const u = new URL(href); let went: string | null = null;
  vm.runInNewContext(code, { window: { __simConfig: config }, document: { cookie }, Date: { now: () => now },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    location: { href, origin: u.origin, pathname: u.pathname, search: u.search, replace: (to: string) => { went = to; } }, encodeURIComponent });
  return went;
}

test('a first visit to a world on a satellite goes to the sync first and comes back to the same address', () => {
  assert.equal(visit('https://soul.game/w/eden/#watch'), 'https://clerk.soul.game/v1/client/sync?redirect_url=https%3A%2F%2Fsoul.game%2Fw%2Feden%2F%23watch');
});

test('it never syncs twice, and leaves everything else alone', () => {
  assert.equal(visit('https://soul.game/w/eden/?__clerk_synced=true'), null, 'back from the sync');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: '__client_uat_Xy12=1760000000' }), null, 'signed in (suffixed cookie)');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: 'a=1; __client_uat=1760000000' }), null, 'signed in (plain cookie)');
  assert.equal(visit('https://soul.game/w/eden/', { stored: String(1_000_000 - 5000) }), null, 'tried a moment ago: a blocked cookie never loops');
  assert.notEqual(visit('https://soul.game/w/eden/', { stored: String(1_000_000 - 120_000) }), null, 'a minute later, it may try again');
  assert.equal(visit('https://soul.game/w/eden/?shot=1'), null, 'a picture page');
  assert.equal(visit('https://soul.game/'), null, 'not a world page');
  assert.equal(visit('https://soul.game/w/eden/', { config: { authProvider: 'clerk' } }), null, 'the primary domain itself');
  assert.equal(visit('https://soul.game/w/eden/', { config: { authProvider: 'dev' } }), null, 'a dev world');
  assert.equal(visit('https://soul.game/w/eden/', { config: { ...sat, clerkSatellite: { domain: 'evil.example/x?' } } }), null, 'a strange domain');
});

test('only on the satellite\'s own origin: a preview host or local dev never leaves for the sync', () => {
  assert.notEqual(visit('https://soul.game/w/eden/'), null, 'the satellite itself');
  assert.equal(visit('https://preview-123.soul.game/w/eden/'), null, 'a preview host');
  assert.equal(visit('http://127.0.0.1:4710/w/eden/'), null, 'local dev');
  assert.equal(visit('http://soul.game/w/eden/'), null, 'not https');

});

// #1385: Clerk JS 5 syncs a satellite on load whenever the "client updated at" cookie is missing or not above 0, so a
// signed-out visit that skipped this left the page about 13 s in (after the arrival card) and booted the world twice.
test('a signed-out visit (cookie 0) syncs before the world loads, as Clerk would after it', () => {
  const to = 'https://clerk.soul.game/v1/client/sync?redirect_url=https%3A%2F%2Fsoul.game%2Fw%2Feden%2F';
  assert.equal(visit('https://soul.game/w/eden/'), to, 'cookie absent');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: 'a=1; __client_uat=0' }), to, 'cookie 0');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: '__client_uat=0; __client_uat_Xy12=0' }), to, 'both cookies 0');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: '__client_uat=1760000000; __client_uat_Xy12=0' }), to, 'the suffixed cookie wins, as in Clerk');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: '__client_uat=0; __client_uat_Xy12=1760000000' }), null, 'signed in by the suffixed cookie');
});

test('no loop: back from the sync it loads once, and a later signed-out visit may sync again', () => {
  const store = new Map<string, string>(), cookie = '__client_uat=0; __client_uat_Xy12=0';
  assert.notEqual(visit('https://soul.game/w/eden/', { cookie, store }), null, 'leaves for the sync');
  assert.equal(visit('https://soul.game/w/eden/?__clerk_synced=true', { cookie, store, now: 1_000_500 }), null, 'back from it: stays');
  assert.equal(store.has('soul.clerk-presync'), false, 'a sync that came back clears the minute guard');
  assert.notEqual(visit('https://soul.game/w/eden/', { cookie, store, now: 1_010_000 }), null, 'a reload ten seconds later syncs first again, before the world loads');
  const lost = new Map<string, string>();
  assert.notEqual(visit('https://soul.game/w/eden/', { cookie, store: lost }), null);
  assert.equal(visit('https://soul.game/w/eden/', { cookie, store: lost, now: 1_000_500 }), null, 'a sync that came back without its marker never loops');
});

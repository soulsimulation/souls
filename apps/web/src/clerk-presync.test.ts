// node --test apps/web/src/clerk-presync.test.ts — #1266 G4: a satellite's first visit syncs with Clerk before the world loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = /<script id="clerk-presync">([\s\S]*?)<\/script>/.exec(html)![1];
const sat = { authProvider: 'clerk', clerkSatellite: { domain: 'soul.game', signInUrl: 'https://primary.example/sign-in' } };
function visit(href: string, { config = sat as unknown, cookie = '', stored = null as string | null, now = 1_000_000 } = {}) {
  const u = new URL(href), store = new Map<string, string>(stored ? [['soul.clerk-presync', stored]] : []); let went: string | null = null;
  vm.runInNewContext(code, { window: { __simConfig: config }, document: { cookie }, Date: { now: () => now },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    location: { href, origin: u.origin, pathname: u.pathname, search: u.search, replace: (to: string) => { went = to; } }, encodeURIComponent });
  return went;
}

test('a first visit to a world on a satellite goes to the sync first and comes back to the same address', () => {
  assert.equal(visit('https://soul.game/w/eden/#watch'), 'https://clerk.soul.game/v1/client/sync?redirect_url=https%3A%2F%2Fsoul.game%2Fw%2Feden%2F%23watch');
});

test('it never syncs twice, and leaves everything else alone', () => {
  assert.equal(visit('https://soul.game/w/eden/?__clerk_synced=true'), null, 'back from the sync');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: 'a=1; __client_uat=0' }), null, 'synced before (signed out)');
  assert.equal(visit('https://soul.game/w/eden/', { cookie: '__client_uat_Xy12=1760000000' }), null, 'synced before (signed in)');
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

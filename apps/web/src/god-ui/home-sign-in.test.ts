// node --test apps/web/src/god-ui/home-sign-in.test.ts — the home page opens "New world" after a sign-in only when
// "+ New world" started that sign-in; a plain "Sign in" lands on the home page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHomeSignIn, takeNewWorldIntent } from './home-sign-in.ts';

function run(newWorld: boolean, search: string, signInUrl?: string) {
  const calls: string[] = [];
  startHomeSignIn({ signInUrl, login: () => calls.push('login') }, newWorld, { pathname: '/', search }, { assign: (u) => calls.push('assign ' + u), replaceAddress: (u) => calls.push('address ' + u) });
  return calls;
}

test('"+ New world" signs in with the intent in the return address; "Sign in" carries none', () => {
  assert.deepEqual(run(true, ''), ['address /?new=1', 'login'], 'Clerk and dev sign in return to the address they started from');
  assert.deepEqual(run(false, ''), ['address /', 'login']);
  assert.deepEqual(run(false, '?new=1&__clerk_synced=true'), ['address /?__clerk_synced=true', 'login'], 'a stale intent never rides a plain sign-in');
  assert.deepEqual(run(true, '?__clerk_synced=true'), ['address /?__clerk_synced=true&new=1', 'login']);
  assert.deepEqual(run(true, '', 'https://soul.game/'), ['assign https://soul.game/?new=1'], 'a preview host: sign in on the canonical site, intent kept');
  assert.deepEqual(run(false, '', 'https://soul.game/'), ['assign https://soul.game/']);
});

test('back on the home page: the intent opens the dialog once and leaves the address; no intent, no dialog', () => {
  assert.deepEqual(takeNewWorldIntent({ pathname: '/', search: '?new=1', hash: '' }), { open: true, address: '/' });
  assert.deepEqual(takeNewWorldIntent({ pathname: '/', search: '?new=1&__clerk_synced=true', hash: '' }), { open: true, address: '/?__clerk_synced=true' }, 'through the satellite sync');
  assert.deepEqual(takeNewWorldIntent({ pathname: '/', search: '?__clerk_synced=true', hash: '' }), { open: false, address: null }, 'a plain sign-in back from the sync');
  assert.deepEqual(takeNewWorldIntent({ pathname: '/', search: '', hash: '' }), { open: false, address: null });
});

// Homepage sign-in: "Sign in" comes back to the homepage with nothing open; "+ New world" signed out signs in, then New world opens (?new=1).
import test from 'node:test'; import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { publishSession } from '../auth-session.ts';
import { homeSignIn, LauncherHome, type LauncherList } from './LauncherHome.tsx';

const list: LauncherList = { contract: 'local-worlds/1', launcher: 'test', worlds: [], templates: [] };
/** A fresh homepage at `search`; records where sign-in would send the browser and what the address became. */
function page(search = '') {
  const seen = { assigned: [] as string[], logins: 0, search };
  Object.assign(globalThis, {
    location: { origin: 'https://sim.example', pathname: '/', get search() { return seen.search; }, hash: '', assign(u: string) { seen.assigned.push(u); } },
    history: { replaceState(_s: unknown, _t: string, u: string) { seen.search = new URL(u, 'https://sim.example').search; }, pushState() {}, state: null, length: 1 },
  });
  return seen;
}
const session = (seen: { logins: number }, signInUrl?: string) => ({ signInUrl, login() { seen.logins++; } });

test('Sign in opens sign-in and leaves the address as it is: no ?new=1, so nothing opens on the way back', () => {
  const seen = page();
  homeSignIn(session(seen), false);
  assert.equal(seen.logins, 1);
  assert.equal(seen.search, '');
  const other = page();
  homeSignIn(session(other, 'https://accounts.example/sign-in'), false);
  assert.deepEqual(other.assigned, ['https://accounts.example/sign-in']);
});

test('+ New world while signed out signs in first and marks the return with ?new=1', () => {
  const seen = page();
  homeSignIn(session(seen), true);
  assert.equal(seen.logins, 1);
  assert.equal(seen.search, '?new=1');
  const other = page();
  homeSignIn(session(other, 'https://accounts.example/sign-in'), true);
  assert.deepEqual(other.assigned, ['https://accounts.example/sign-in?new=1']);
});

test('back from sign-in, the homepage opens New world only when the address says ?new', () => {
  publishSession({ mode: 'clerk', ready: true, authed: true, label: 'kim', avatarUrl: null, getToken: async () => null, login() {}, logout() {} });
  page('');
  assert.doesNotMatch(renderToStaticMarkup(<LauncherHome initial={list}/>), /role="dialog"/);
  page('?new=1');
  assert.match(renderToStaticMarkup(<LauncherHome initial={list}/>), /role="dialog"/);
});

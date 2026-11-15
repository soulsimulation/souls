import test from 'node:test'; import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { publishSession } from '../auth-session.ts';
import { LauncherHome, type LauncherList } from './LauncherHome.tsx';

Object.assign(globalThis, { location: { origin: 'https://sim.example', pathname: '/', search: '', hash: '' } });
const list: LauncherList = { contract: 'local-worlds/1', launcher: 'test', worlds: [], templates: [] };
const signedIn = (avatarUrl: string | null) => publishSession({ mode: 'clerk', ready: true, authed: true, label: 'kim@example.com', avatarUrl, getToken: async () => null, login() {}, logout() {} });

test('the homepage account chip shows the account picture, as a world page does', () => {
  signedIn('https://img.example/kim.png');
  const html = renderToStaticMarkup(<LauncherHome initial={list}/>);
  assert.match(html, /class="lh-avatar"[^>]*><img src="https:\/\/img\.example\/kim\.png" alt="" referrerPolicy="no-referrer"\/><\/button>/);
});

test('the homepage account chip falls back to the initial only when the account has no picture', () => {
  signedIn(null);
  const html = renderToStaticMarkup(<LauncherHome initial={list}/>);
  assert.doesNotMatch(html, /<img src="https:\/\/img/);
  assert.match(html, /class="lh-avatar"[^>]*><span aria-hidden="true">K<\/span><\/button>/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMenuRows, MENU_TARGETS } from './hud-menu.ts';

type El = { click(): void; textContent: string; hidden: boolean; getAttribute(n: string): string | null; clicked?: number };
const el = (text: string, attrs: Record<string, string> = {}, hidden = false): El => {
  const e: El = { textContent: text, hidden, getAttribute: (n) => attrs[n] ?? null, click() { e.clicked = (e.clicked ?? 0) + 1; } };
  return e;
};
const page = (map: Record<string, El[]>) => ({ querySelectorAll: (s: string) => map[s] ?? [] });
const sel = (key: string) => MENU_TARGETS.find((t) => t.key === key)!.selector;

test('rows follow the issue order: time, search, souls, god, music, camera, extras, account last', () => {
  const rows = collectMenuRows(page({
    [sel('profile')]: [el('', { 'aria-label': 'Account menu' })],
    [sel('camera')]: [el('⌄', { 'aria-label': 'Camera modes and help' })],
    '.hud-camera-slot .camera-main span': [el('Broadcast')],
    [sel('music')]: [el('', { 'aria-label': 'Audio' })],
    [sel('god')]: [el('', { 'aria-label': 'God mode, connected' })],
    [sel('souls')]: [el('', { 'aria-label': 'Open Ada' }), el('', { 'aria-label': 'Open Bo' })],
    [sel('search')]: [el('', { 'aria-label': 'Explore Hamlet' })],
    [sel('time')]: [el('Live')],
    '.hud-status [data-viewer-status]': [el(' Live ')],
    [sel('feedback')]: [el('Send feedback')],
  }));
  assert.deepEqual(rows.map((r) => r.key), ['time', 'search', 'souls', 'souls-1', 'god', 'music', 'camera', 'feedback', 'profile']);
  assert.equal(rows[0].value, 'Live');
  assert.equal(rows.find((r) => r.key === 'camera')!.value, 'Broadcast');
  assert.equal(rows.find((r) => r.key === 'souls-1')!.label, 'Open Bo');
  assert.equal(rows.at(-1)!.section, 'account');
});

test('a row clicks the control it stands for; absent and hidden controls get no row', () => {
  const music = el('', { 'aria-label': 'Audio' }), hiddenSearch = el('', {}, true);
  const rows = collectMenuRows(page({ [sel('music')]: [music], [sel('search')]: [hiddenSearch], [sel('sign-in')]: [el('Sign in')] }));
  assert.deepEqual(rows.map((r) => r.key), ['music', 'feedback', 'sign-in']);  // feedback: the signed-out fallback
  rows[0].target.click();
  assert.equal(music.clicked, 1);
  assert.ok(!rows.some((r) => r.key === 'god'), 'a visitor has no God row');
});

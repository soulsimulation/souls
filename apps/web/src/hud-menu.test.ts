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
    [sel('new-soul')]: [el('New Soul')],
    [sel('search')]: [el('', { 'aria-label': 'Explore Hamlet' })],
    [sel('time')]: [el('Live')],
    '.hud-status [data-viewer-status]': [el(' Live ')],
    [sel('feedback')]: [el('Send feedback')],
  }));
  assert.deepEqual(rows.map((r) => r.key), ['time', 'search', 'new-soul', 'god', 'music', 'camera', 'feedback', 'profile']);
  assert.equal(rows[0].value, 'Live');
  assert.equal(rows.find((r) => r.key === 'camera')!.value, 'Broadcast');
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

test('the Souls section shows up to 5, and all when expanded', async () => {
  const { menuSoulsShown, MENU_SOULS_SHOWN } = await import('./hud-menu.ts');
  assert.equal(MENU_SOULS_SHOWN, 5);
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.deepEqual(menuSoulsShown(seven, false), { shown: ['a', 'b', 'c', 'd', 'e'], hidden: 2 });
  assert.deepEqual(menuSoulsShown(seven, true), { shown: seven, hidden: 0 });
  assert.deepEqual(menuSoulsShown(['a', 'b'], false), { shown: ['a', 'b'], hidden: 0 });
});

test('the menu offers one Souls slot that MySouls reads; a new element notifies, the same one does not', async () => {
  const { setMenuSoulsSlot, menuSoulsSlot, subscribeMenuSoulsSlot } = await import('./hud-menu.ts');
  let n = 0; const off = subscribeMenuSoulsSlot(() => n++);
  const el = {} as HTMLElement; let closed = 0;
  setMenuSoulsSlot(el, () => closed++); setMenuSoulsSlot(el, () => closed++);
  assert.equal(n, 1); assert.equal(menuSoulsSlot().el, el);
  menuSoulsSlot().close(); assert.equal(closed, 1);
  setMenuSoulsSlot(null, () => {}); assert.equal(n, 2); assert.equal(menuSoulsSlot().el, null);
  off();
});

test('the New Soul row stands aside when the Souls list (with its own New Soul) is in the menu', () => {
  const ns = { [sel('new-soul')]: [el('New Soul')] };
  assert.ok(collectMenuRows(page(ns)).some((r) => r.key === 'new-soul'));
  assert.ok(!collectMenuRows(page({ ...ns, '.hud-menu-souls': [el('Souls')] })).some((r) => r.key === 'new-soul'));
});

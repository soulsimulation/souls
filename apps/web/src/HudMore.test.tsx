import test from 'node:test'; import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { HudMore, MORE_TARGETS, SMALL_SCREEN, collectMoreItems, moreMenu } from './HudMore.tsx';
import { HudMenu } from './HudMenu.tsx';
import { PHONE_WIDTH } from './hud-menu.ts';

// #1391: the screen classes by media query. Desktop: neither query; tablet: a coarse pointer wider than a phone (the
// small-screen query only); phone: both. `asked` records which queries were made.
const screens = { desktop: [] as string[], tablet: [SMALL_SCREEN], phone: [SMALL_SCREEN, PHONE_WIDTH] };
function onScreen<T>(matching: string[], asked: string[], run: () => T): T {
  const g = globalThis as { matchMedia?: unknown };
  const prior = g.matchMedia;
  g.matchMedia = (q: string) => { asked.push(q); return { matches: matching.includes(q), addEventListener() {}, removeEventListener() {} }; };
  try { return run(); } finally { g.matchMedia = prior; }
}

test('desktop shows neither the More button nor the hamburger (no matchMedia, a desktop matchMedia, or forced off)', () => {
  assert.equal(renderToStaticMarkup(<HudMore/>), '');
  assert.equal(renderToStaticMarkup(<HudMore small={false} initialOpen/>), '');
  assert.equal(renderToStaticMarkup(<HudMore small={false} phone initialOpen/>), '');
  const asked: string[] = [];
  assert.equal(onScreen(screens.desktop, asked, () => renderToStaticMarkup(<HudMore/>)), '');
  assert.deepEqual([...new Set(asked)].sort(), [PHONE_WIDTH, SMALL_SCREEN].sort());
});

test('tablet width shows one More button, closed until tapped, and no hamburger', () => {
  const closed = onScreen(screens.tablet, [], () => renderToStaticMarkup(<HudMore/>));
  assert.equal(closed.match(/class="hud-camera hud-more"/g)?.length, 1);
  assert.match(closed, /aria-label="More"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /role="menu"/);
  assert.doesNotMatch(closed, /class="hud-menu"/);
  const open = renderToStaticMarkup(<HudMore small phone={false} initialOpen/>);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /role="menu"/);
});

test('phone width shows the hamburger instead of More, closed until tapped', () => {
  const closed = onScreen(screens.phone, [], () => renderToStaticMarkup(<HudMore/>));
  assert.equal(closed.match(/class="hud-menu"/g)?.length, 1);
  assert.match(closed, /aria-label="Menu"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /data-open="false"/);
  assert.doesNotMatch(closed, /hud-more/);
  const open = renderToStaticMarkup(<HudMenu initialOpen/>);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /data-open="true"/);
});

test('open/close: the button toggles; Escape, a tap outside and an item close it', () => {
  assert.equal(moreMenu(false, 'toggle'), true);
  assert.equal(moreMenu(true, 'toggle'), false);
  assert.equal(moreMenu(true, 'close'), false);
  assert.equal(moreMenu(false, 'close'), false);
});

test('menu items are the existing controls on the page; choosing one clicks that control', () => {
  const clicked: string[] = [];
  const el = (name: string, o: { text?: string; aria?: string; hidden?: boolean; onScreen?: boolean } = {}) => ({ click: () => clicked.push(name), textContent: o.text ?? '', hidden: o.hidden ?? false, getAttribute: (a: string) => (a === 'aria-label' ? o.aria ?? null : null), checkVisibility: () => o.onScreen ?? false });
  const page: Record<string, ReturnType<typeof el>[]> = {
    '.account-sign-in': [el('signin', { text: 'Sign in' })],
    '[data-god-panel-toggle]': [el('claim', { text: '✦ Claim this world' })],
    '[data-god-open]': [el('god', { text: 'God⌘G' })],
    '[data-feedback-open]': [el('feedback', { text: 'Send feedback' })],
    '.visitor-controls button': [el('away', { text: 'Since your last visit' })],
    '.camera-menu .fullscreen-toggle': [el('fullscreen', { aria: 'Full screen', onScreen: true })],
    '.hud-camera-slot .camera-main': [el('broadcast', { text: 'Broadcast' })],
    '.camera-menu .navbar-menu-trigger': [el('camera', { aria: 'Camera controls', onScreen: true })],
    '.hud-explore-group .my-souls > button, .souls-menu .navbar-menu-trigger': [el('ada', { aria: 'Open Ada' })],
    '.navbar-audio .navbar-menu-trigger': [el('audio', { aria: 'Audio' })],
  };
  assert.deepEqual(Object.keys(page), MORE_TARGETS.map((t) => t.selector));
  const items = collectMoreItems({ querySelectorAll: (s) => page[s] ?? [] });
  // U3: what is still on screen (Full screen, Camera controls here) is not offered twice
  assert.deepEqual(items.map((i) => i.label), ['Sign in', 'Claim this world', 'God', 'Feedback', 'Since your last visit', 'Broadcast', 'Open Ada', 'Audio']);
  assert.deepEqual(items.map((i) => i.key), ['sign-in', 'claim', 'god', 'feedback', 'visitor', 'follow', 'souls', 'sound']);
  items[3].target.click(); items[7].target.click();
  assert.deepEqual(clicked, ['feedback', 'audio']);
});

test('signed out (no account menu), More still offers Feedback; nothing else is invented', () => {
  const items = collectMoreItems({ querySelectorAll: () => [] });
  assert.deepEqual(items.map((i) => [i.key, i.label]), [['feedback', 'Feedback']]);
});

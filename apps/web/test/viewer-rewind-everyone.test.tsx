import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewerFrame } from '../src/ViewerFrame.tsx';
import type { WorldViewerHandle, WorldViewerState } from '../src/WorldViewer.ts';

// The arrival light looks for the boot page's progress bar while it renders; this file has no page.
(globalThis as { document?: unknown }).document ??= { querySelector: () => null };

// Gene, "Show it to everyone": the rewind ("Back 1 min") shows to every viewer, with no `?rewind` in the address.
test('the rewind shows with no query flag and is pressable once a moment is drawn', () => {
  assert.equal(location.search, ''); // the address carries no `?rewind`
  const state = { shownTick: 12_000, loading: false, presentation: 'live', selection: { soulId: null } } as unknown as WorldViewerState;
  const html = renderToStaticMarkup(createElement(ViewerFrame, { handle: {} as WorldViewerHandle, state, dt: 0.1, navigationOpen: false, onNavigationChange() {} }));
  assert.match(html, /<button>Back 1 min<\/button>/);
});

test('before a moment is drawn the rewind is there but cannot be pressed', () => {
  const html = renderToStaticMarkup(createElement(ViewerFrame, { handle: null, state: null, dt: 0.1, navigationOpen: false, onNavigationChange() {} }));
  assert.match(html, /<button disabled="">Back 1 min<\/button>/);
});

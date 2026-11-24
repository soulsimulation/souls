import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewerFrame } from '../src/ViewerFrame.tsx';
import type { WorldViewerHandle, WorldViewerState } from '../src/WorldViewer.ts';

// The arrival light looks for the boot page's progress bar while it renders; this file has no page.
(globalThis as { document?: unknown }).document ??= { querySelector: () => null };

// Gene, "Show it to everyone": the time controls (Back 1 min among them) show to every viewer, with no `?rewind` in the
// address. Gene (24 Nov): the header holds one time control, the pill; Back 1 min and the rest are in the panel it opens.
const live = { shownTick: 12_000, loading: false, presentation: 'live', playback: 'live', selection: { soulId: null } } as unknown as WorldViewerState;
const frame = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ViewerFrame, { handle: {} as WorldViewerHandle, state: live, dt: 0.1, navigationOpen: false, onNavigationChange() {}, ...props }));

test('the time pill shows with no query flag and is pressable once a moment is drawn', () => {
  assert.equal(location.search, ''); // the address carries no `?rewind`
  const html = frame({});
  assert.match(html, /<button type="button" class="time-pill"/);
  assert.doesNotMatch(html, /class="time-pill" disabled/);
  assert.match(html, />Live</);
});

test('before a moment is drawn the pill is there but cannot be pressed', () => {
  const html = frame({ handle: null, state: null });
  assert.match(html, /<button type="button" class="time-pill" disabled=""/);
});

test('the header has no other time control, with or without a world clock: they are in the time panel', () => {
  for (const props of [{}, { worldTime: 'Sat · 6:12 am' }, { state: { ...live, presentation: 'history', playback: 'playing' } }]) {
    const html = frame(props);
    assert.doesNotMatch(html, /Back 1 min|Link to this moment|From the start|Return to live|Pause|>Play<|Preview|type="range"|world-time-button/);
    assert.equal((html.match(/class="time-pill"/g) ?? []).length, 1);
  }
});

test("a recording's pill reads Recorded with the clock of the moment shown", () => {
  const html = frame({ state: { ...live, presentation: 'history', playback: 'paused' }, worldTime: 'Sat · 6:12 am' });
  assert.match(html, /Recorded · 6:12 am/);
});

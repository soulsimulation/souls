// #4159: the page reads its live stream from the CDN only when its config names exactly that origin.
//   node --test apps/web/src/v2-engine/stream-cdn.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_CDN, streamReadUrl } from './stream-cdn.ts';

const S = '/s/w/abc-abc-0/views/abc/abc-0/0/abc-0/1/everyone/';

test('the configured CDN origin: the same path on the CDN', () => {
  assert.equal(STREAM_CDN, 'https://stream.soul.game');
  assert.equal(streamReadUrl(S, { v2StreamOrigin: STREAM_CDN }, ''), `https://stream.soul.game${S}`);
  assert.equal(new URL('pointer', streamReadUrl(S, { v2StreamOrigin: STREAM_CDN }, '?x=1')).href, `https://stream.soul.game${S}pointer`);
});

test('no CDN named, another origin named, or ?streamcdn=0: the page origin, unchanged', () => {
  for (const config of [undefined, {}, { v2StreamOrigin: null }, { v2StreamOrigin: 'https://evil.example' }, { v2StreamOrigin: 'http://stream.soul.game' },
    { v2StreamOrigin: 'https://stream.soul.game/' }, { v2StreamOrigin: 'https://stream.soul.game.evil.example' }, { v2StreamOrigin: ['https://stream.soul.game'] }]) {
    assert.equal(streamReadUrl(S, config, ''), S, JSON.stringify(config));
  }
  assert.equal(streamReadUrl(S, { v2StreamOrigin: STREAM_CDN }, '?streamcdn=0'), S);
  assert.equal(streamReadUrl(S, { v2StreamOrigin: STREAM_CDN }, '?hour=12:00&streamcdn=0'), S);
  assert.equal(streamReadUrl(S, { v2StreamOrigin: STREAM_CDN }, '?streamcdn=1'), `https://stream.soul.game${S}`);
});

test('only a /s/ path is ever put on the CDN', () => {
  assert.equal(streamReadUrl('/w/eden/v2/bodies/', { v2StreamOrigin: STREAM_CDN }, ''), '/w/eden/v2/bodies/');
});

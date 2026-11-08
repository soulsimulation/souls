// #1393: on a page where music has never been on, previous/next still choose a track: only the order's tiny chunk loads,
// no player and no audio element.
import test from 'node:test';
import assert from 'node:assert/strict';
import { musicState, skipPiece, syncMusic } from './music.ts';
import { musicView } from '../music-status.ts';

test('a skip with music never on loads the order alone and selects a track', async () => {
  syncMusic({ on: false, volume: 0.3, unlocked: false });
  assert.equal(musicState().playlist.length, 0);
  skipPiece(1);
  for (let i = 0; i < 50 && !musicState().playlist.length; i++) await new Promise(r => setImmediate(r));
  const s = musicState();
  assert.ok(s.playlist.length > 2); assert.equal(s.index, 1, 'the first next selects the second piece');
  assert.equal(musicView().piece, s.playlist[1]); assert.equal(musicView().status, 'off');
  assert.equal(s.loaded, false, 'no player loaded'); assert.equal(s.playing, null);
  skipPiece(-1); skipPiece(-1); assert.equal(musicState().index, s.playlist.length - 1, 'wraps');
});

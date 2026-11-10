// #1645: the proof recorder's timecode is drawn without ffmpeg's drawtext, as a small chip and a thin progress line,
// never a full-width dark band.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIMECODE, overlayGraph, timecodeLabel, timecodeSprite } from '../../.claude/skills/proof/record.mjs';

test('timecodeLabel: tenths of the clip time over its whole length', () => {
  assert.equal(timecodeLabel(0, 20.4), '0:00.0 / 0:21');
  assert.equal(timecodeLabel(7.34, 21), '0:07.3 / 0:21');
  assert.equal(timecodeLabel(65.05, 90), '1:05.0 / 1:30');
});

test('timecodeSprite: one cell per tenth to the end of the clip, in rows; a long clip gets a coarser step', () => {
  const s = timecodeSprite(20);
  assert.equal(s.step, 0.1); assert.ok(s.cells * s.step >= 20); assert.equal(s.labels[73], '0:07.3 / 0:20');
  assert.equal(s.rows, Math.ceil(s.cells / s.cols)); assert.equal(s.width, s.cols * TIMECODE.cell.width);
  const long = timecodeSprite(3600);
  assert.ok(long.step >= 1 && long.cells <= long.cols * TIMECODE.maxRows, 'a sprite for an hour stays a screenshot-sized image');
});

test('overlayGraph: no drawtext and no full-width band; the chip is cropped from the sprite by time', () => {
  const sprite = timecodeSprite(12), g = overlayGraph({ width: 1280, durationSec: 12, sprite });
  assert.doesNotMatch(g, /drawtext|drawbox/);
  assert.match(g, /crop=w=132:h=24:x='mod\(floor\(t\/0\.1\+0\.0001\),10\)\*132':y='floor\(floor\(t\/0\.1\+0\.0001\)\/10\)\*24'/);
  assert.match(g, /color=c=0xffc400:s=1280x4/, 'a 4 px progress line');
  assert.match(g, /overlay=x='-w\+W\*t\/12\.00':y=H-4/);
  const bare = overlayGraph({ width: 390, durationSec: 5, sprite: null });
  assert.doesNotMatch(bare, /\[1:v\]|crop|drawbox/); assert.match(bare, /^color=c=0xffc400:s=390x4/);
});

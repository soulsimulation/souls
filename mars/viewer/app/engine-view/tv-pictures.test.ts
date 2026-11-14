// classroom-tv/1 (#2302): the classroom TV shows the same four pictures as the library television (core-television@2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TV_PICTURE_ART } from './tv-pictures.ts';
import { PICTURES, TV_CHANNELS } from '../../../../packages/world-compiler/src/core-kit/families/television.family.ts';
import { TV_PICTURES } from '../../engine/objects/classroom.ts';

test('the classroom TV pictures are the core-television@2 pictures, plus the lesson', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(TV_PICTURE_ART)), JSON.parse(JSON.stringify(PICTURES)));
  assert.deepEqual(TV_PICTURES, ['lesson', ...TV_CHANNELS]);
});

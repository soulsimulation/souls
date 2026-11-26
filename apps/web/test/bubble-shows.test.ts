// Page FPS: an empty speech bubble is left out of the CSS2D pass; it comes back when it holds a shown pop-up or dot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bubbleShows } from '../src/dialogue-speaking.ts';
import { TAG_SHOWN_MIN, fadeCard } from '../src/WorldCardSight.ts';

const bubble = (...hidden: boolean[]) => ({ children: hidden.map((h) => ({ hidden: h })) }) as unknown as Element;

test('a bubble shows only while a child of it is not hidden', () => {
  assert.equal(bubbleShows(bubble()), false);
  assert.equal(bubbleShows(bubble(true)), false);
  assert.equal(bubbleShows(bubble(true, true)), false);
  assert.equal(bubbleShows(bubble(true, false)), true);
  assert.equal(bubbleShows(bubble(false)), true);
});

test('a card fading in crosses TAG_SHOWN_MIN within a frame or two, so a culled tag comes back at once', () => {
  let shown = 0, frames = 0;
  while (shown < TAG_SHOWN_MIN && frames < 10) { shown = fadeCard(shown, 0.8, 1 / 60); frames++; }
  assert.ok(frames <= 2, `${frames} frames`);
});

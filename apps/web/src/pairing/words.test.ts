// #5006 row 4: a creator's request reads as a creator's on the pairing card; a Soul's keeps its words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pairWords } from './words.ts';

test('a creator request asks to build the world, never to act as a Soul', () => {
  const w = pairWords('creator');
  assert.match(w.heading, /build your world as its creator/);
  assert.match(w.approved, /build your world as its creator/);
  assert.match(w.warn, /change your world/);
  assert.ok(w.what);
  for (const said of [w.heading, w.warn, w.term, w.what, w.approved]) assert.doesNotMatch(said, /Soul/, said);
});

test('a Soul request keeps the Soul words the page starts with', () => {
  const w = pairWords('soul');
  assert.equal(w.heading, 'A device is asking to act as your Soul');
  assert.equal(w.approved, 'Approved. The device now holds your Soul.');
  assert.equal(w.term, 'Soul');
  assert.equal(w.what, null);
  assert.deepEqual(pairWords(undefined), w, 'an answer without a scope is a Soul\'s');
  // the page's own first words are the Soul's, so a Soul's card reads the same before and after the request shows
  const page = readFileSync(new URL('../../pair.html', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.ok(page.includes(`<h1 id="heading">${w.heading}</h1>`));
  assert.ok(page.includes(w.warn), 'the warning on the page is the Soul\'s');
});

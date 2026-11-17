// The catalog lists a god's carousel and big wheel carriers by their own kind, not the balloon's def they ride on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {listedKind} from './edge/catalog/routes.ts';

test('carousel and ferris-wheel carriers are listed as themselves; a balloon stays a hot-air-balloon', () => {
  const car = (route: string) => ({def: 'hot-air-balloon', carrier: {route: {id: route}}});
  assert.equal(listedKind('resort-carousel', car('carousel-three-turns')), 'carousel');
  assert.equal(listedKind('resort-ferris-wheel', car('ferris-wheel-gondola')), 'ferris-wheel');
  assert.equal(listedKind('eden-balloon', car('commons-hop')), 'hot-air-balloon');
  assert.equal(listedKind('wheel-1', {def: 'rowing-punt'}), 'rowing-punt');
  assert.equal(listedKind('x', {def: 'core-carousel'}), 'core-carousel');
});

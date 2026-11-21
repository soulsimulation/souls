// 0.131 models: the page finds a world's models beside its page when no `models` root is given, and keeps the world
// view's boxes when the models' index cannot be had.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { WorldView } from '../draw/world.ts';
import { modelsRoot, pageThings } from './page.ts';

const PAGE = 'https://soul.game/w/eden/';

test('the models root is models/ beside the world page unless the page names one', () => {
  assert.equal(modelsRoot(new URLSearchParams(), PAGE).href, 'https://soul.game/w/eden/models/');
  assert.equal(modelsRoot(new URLSearchParams(), 'https://soul.game/w/eden/index.html?x=1').href, 'https://soul.game/w/eden/models/');
  assert.equal(modelsRoot(new URLSearchParams('models=/m/'), PAGE).href, 'https://soul.game/m/');
});

test('a world whose models.json fails keeps its boxes', async () => {
  (globalThis as { location?: unknown }).location = { href: PAGE };
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (s: string) => void warned.push(s);
  try {
    const world = { drawThings: true } as WorldView;
    const asked: string[] = [];
    const things = pageThings(new THREE.Scene(), world, new URLSearchParams(), (root) => {
      asked.push(root);
      return Promise.reject(new Error('models.json: 404'));
    });
    assert.equal(world.drawThings, false, 'no boxes while the index is on its way');
    things.apply([], []);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(asked, ['https://soul.game/w/eden/models/']);
    assert.equal(world.drawThings, true, 'the world view draws its boxes');
    assert.equal(things.layer, null);
    assert.match(warned[0] ?? '', /models\.json: 404; things drawn as boxes/);
    things.apply([], []); // after the failure, parts are left to the world view
  } finally {
    console.warn = warn;
  }
});

test('things=0 draws neither models nor boxes and asks for nothing', () => {
  const world = { drawThings: true } as WorldView;
  pageThings(new THREE.Scene(), world, new URLSearchParams('things=0'), () => assert.fail('no index asked for'));
  assert.equal(world.drawThings, false);
});

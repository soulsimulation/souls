// A new Soul arrives in a light (N-V19, #3677): which bodies are arrivals, and the light's life on the world clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARRIVAL_S, ArrivalLights, ArrivalWatch, MAX_LIGHTS, envelope } from './arrival.ts';

test('bodies there when the page first draws are not arrivals; a new one later is, once', () => {
  const w = new ArrivalWatch(3000);
  assert.equal(w.placed('a', 1000), false);
  assert.equal(w.placed('b', 1000), false);
  assert.equal(w.placed('c', 2500), false, 'still the world loading');
  assert.equal(w.placed('d', 4000), true);
  assert.equal(w.placed('d', 9000), false, 'an id seen before never lights again');
  assert.equal(w.placed('a', 9000), false, 'a reconnect re-adding a body is not an arrival');
});

test('the light rises, holds and goes out', () => {
  assert.equal(envelope(0), 0);
  assert.equal(envelope(0.04), 0.5);
  assert.equal(envelope(0.3), 1);
  assert.ok(envelope(0.8) > 0 && envelope(0.8) < 1);
  assert.equal(envelope(1), 0);
});

test('a light follows its body on the world clock, holds while the clock holds, and is drawn only while on', () => {
  const l = new ArrivalLights(new ArrivalWatch(0));
  const S = 1e6;
  l.begin(10 * S);
  l.place('old', 0, 0, 0, true, 0); // with no settle every fresh body lights; the watch's own test covers the settle
  assert.equal(l.begun, 1);
  l.draw();
  assert.equal(l.mesh.visible, true);
  assert.equal(l.mesh.count, 1);
  l.begin(11 * S);
  l.place('old', 2, 0, 3, false, 0);
  l.draw();
  const m = new (l.mesh.matrix.constructor as any)();
  l.mesh.getMatrixAt(0, m);
  assert.deepEqual([m.elements[12], m.elements[14]], [2, 3], 'the light moves with the body');
  l.begin(11 * S);
  l.draw();
  assert.equal(l.mesh.count, 1, 'a held clock holds the light');
  l.begin(10 * S + ARRIVAL_S * S);
  l.draw();
  assert.equal(l.mesh.visible, false, 'spent');
  assert.equal(l.active, false);
});

test('at most MAX_LIGHTS at once, the oldest giving way', () => {
  const l = new ArrivalLights(new ArrivalWatch(0));
  l.begin(0);
  for (let i = 0; i < MAX_LIGHTS + 5; i++) l.place(`s${i}`, i, 0, 0, true, 0);
  l.draw();
  assert.equal(l.mesh.count, MAX_LIGHTS);
});

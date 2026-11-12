import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { findAnchors } from './finder.ts';
import { SmokePublishers, watchEntitySmoke, type SmokeSource } from './smoke-publishers.ts';

test('smoke publication preserves legacy chimney geometry, authored order and hidden publishers across scans', () => {
  const scene = new THREE.Scene(), owner = new THREE.Group(), contents = new THREE.Group(); owner.add(contents);
  let published: SmokeSource[] = [];
  const cache = new SmokePublishers(scene, sources => { published = sources; }), stop = watchEntitySmoke(owner, contents);
  const first = new THREE.Group(), second = new THREE.Mesh(new THREE.BoxGeometry(.5, 2, .5));
  first.userData.edenSmokeSources = [[0, 1, 0, .6], [1, 1, 0, .7]];
  second.name = 'stove-pipe'; second.position.set(3, 1, -2); contents.add(first, second);
  try {
    scene.add(owner); cache.update();
    assert.deepEqual(published.map(s => [s.p.toArray(), s.scale]), [[[0, 1, 0], .6], [[1, 1, 0], .7], [[3, 2.1, -2], .8]]);
    const before = published.map(s => [s.p.toArray(), s.scale]);
    cache.beginScan(); const found = findAnchors(scene, () => false, false, cache.capture); cache.update();
    assert.deepEqual(published.map(s => [s.p.toArray(), s.scale]), before, 'event and periodic collection retain source order');
    assert.deepEqual(published, found.smoke, 'legacy geometry and authored metadata agree with the finder');
    first.userData.edenSmokeSources = [[2, 1, 0, .4]]; cache.update();
    assert.deepEqual(published[0], { p: new THREE.Vector3(2, 1, 0), scale: .4 }, 'known metadata replacement refreshes without an event');
    contents.visible = false; cache.update(); assert.equal(published.length, 0);
    cache.beginScan(); findAnchors(scene, () => false, false, cache.capture); cache.update();
    contents.visible = true; cache.update(); assert.equal(published.length, 2, 'uncovering known publishers after a scan refreshes immediately');
    // A root reparent removes cached sources from the old scene and adds them to the destination.
    const destination = new THREE.Scene(); let moved: SmokeSource[] = [];
    const other = new SmokePublishers(destination, sources => { moved = sources; });
    destination.add(owner); cache.update(); other.update();
    assert.equal(published.length, 0); assert.equal(moved.length, 2);
    other.dispose();
    const late = new THREE.Group(); late.userData.edenSmokeSources = [[9, 1, 0]];
    contents.add(late); other.update(); assert.equal(other.updates, 1, 'disposed caches unsubscribe');
  } finally { stop(); cache.dispose(); second.geometry.dispose(); (second.material as THREE.Material).dispose(); }
  // Prove watcher cleanup by an addition after disposal, rather than relying on private event storage.
  let calls = 0; const after = new SmokePublishers(scene, () => { calls++; }); scene.add(owner); contents.add(new THREE.Group()); after.update();
  assert.equal(calls, 0, 'stopped entity watcher publishes no lifecycle events'); after.dispose();
});

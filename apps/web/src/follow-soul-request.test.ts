import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraOnSoul, onFollowSoulRequest, requestFollowSoul } from './follow-soul-request.ts';

test('a ready approval asks the viewer to follow its Soul; only Soul ids cross', () => {
  const bus = new EventTarget(), got: string[] = [];
  const off = onFollowSoulRequest((id) => got.push(id), bus);
  assert.equal(requestFollowSoul('s_new1', bus), true);
  assert.equal(requestFollowSoul('javascript:x', bus), false);
  assert.equal(requestFollowSoul('', bus), false);
  bus.dispatchEvent(new CustomEvent('sim:follow-soul', { detail: { soulId: 42 } }));
  off();
  requestFollowSoul('s_after', bus);
  assert.deepEqual(got, ['s_new1']);
});

test('#2280 A4: only a follow from an approval asks to re-read Me (a reconnect); a chip or Follow is a camera move', () => {
  const bus = new EventTarget(), got: [string, boolean][] = [];
  const off = onFollowSoulRequest((id, approved) => got.push([id, approved]), bus);
  requestFollowSoul('s_other', bus); requestFollowSoul('s_new1', bus, true);
  off();
  assert.deepEqual(got, [['s_other', false], ['s_new1', true]]);
});

test('the card follows a Soul exactly when the camera chip says so: flying to it, following it, or pulled out of it', () => {
  const sel = (soulId: string | null) => ({ soulId });
  assert.equal(cameraOnSoul({ cameraMode: 'broadcast', flyingTo: 's_a', selection: sel(null) }, 's_a'), 'following', 'flying to it after arrival');
  assert.equal(cameraOnSoul({ cameraMode: 'follow', flyingTo: 's_b', selection: sel('s_a') }, 's_a'), null, 'flying to another');
  assert.equal(cameraOnSoul({ cameraMode: 'follow', selection: sel('s_a') }, 's_a'), 'following');
  assert.equal(cameraOnSoul({ cameraMode: 'follow', selection: sel('s_a'), followHeld: true }, 's_a'), 'held', 'pulled out: "Follow again"');
  assert.equal(cameraOnSoul({ cameraMode: 'manual', selection: sel('s_a') }, 's_a'), null);
  assert.equal(cameraOnSoul(null, 's_a'), null);
});

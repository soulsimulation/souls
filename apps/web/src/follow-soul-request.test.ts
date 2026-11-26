import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraOnSoul, followHoldStep, onBroadcastChosen, onFollowSoulRequest, requestBroadcast, requestFollowSoul } from './follow-soul-request.ts';

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

test('0.137: a held #soul follow goes back to its Soul from a Broadcast nobody chose, and lets go when the viewer chooses', () => {
  const live = { presentation: 'live', selection: { soulId: 's_mine' } };
  // the camera handed back to the Broadcast tour while the card stayed open: follow the Soul again
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'broadcast' }), 'refollow');
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'broadcast', selection: { soulId: null } }), 'refollow');
  // following it (dancing, sitting, riding), or flying to it: nothing to do
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'follow' }), 'keep');
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'manual', flyingTo: 's_mine' }), 'keep');
  assert.equal(followHoldStep('s_mine', null), 'keep');
  // a manual drag in progress, or a past moment: never fought
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'broadcast', inputOwned: true }), 'keep');
  assert.equal(followHoldStep('s_mine', { ...live, presentation: 'history', cameraMode: 'broadcast' }), 'keep');
  // the viewer chose: another Soul, a flight to another Soul, or their own camera (pan away, a place)
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'follow', selection: { soulId: 's_other' } }), 'release');
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'manual', flyingTo: 's_other' }), 'release');
  assert.equal(followHoldStep('s_mine', { ...live, cameraMode: 'manual' }), 'release');
});

test('0.137: choosing Broadcast (the camera pill and its menu) is an event the held follow hears, so it is not re-followed', () => {
  const bus = new EventTarget(); let chosen = 0;
  const off = onBroadcastChosen(() => { chosen++; }, bus);
  requestBroadcast(bus); off(); requestBroadcast(bus);
  assert.equal(chosen, 1);
});

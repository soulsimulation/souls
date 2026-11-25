// A refusal's detail as the daemon reads it from a `wireFrame` line, and the next step after an activity's refusal.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { activityTry, answerParts, readableDetail } from './refusal.mjs';

const ada = { id: `ab${'01'.repeat(15)}-7`, name: 'Ada', parent: `cd${'00'.repeat(15)}-1` };
const ground = { id: `cd${'00'.repeat(15)}-1`, name: 'ground', kind: 'eden:ground@1220ff' };
const basket = { id: `cd${'00'.repeat(15)}-9`, name: 'the basket', kind: 'eden:harvest_together@1220ee', parent: ground.id };
const onGround = { id: `ef${'00'.repeat(15)}-3`, parent: ground.id, kind: 'eden:hug_activity' };
const atBasket = { id: `ef${'00'.repeat(15)}-4`, parent: basket.id, kind: 'eden:harvest_together_activity' };
const rows = new Map([ada, ground, basket, onGround, atBasket].map((r) => [r.id, r]));

test('a refusal line keeps its seven fields and its detail, spaces and all; other lines carry none', () => {
  const p = answerParts('answer 4 8450ab 2 together.too-far - - souls:hug: ab:7 stands 7550000 µm from its place');
  assert.deepEqual([p.kind, p.a, p.c, p.d, p.names, p.op], ['answer', '4', '2', 'together.too-far', '-', '-']);
  assert.equal(p.detail, 'souls:hug: ab:7 stands 7550000 µm from its place');
  assert.equal(answerParts('answer 4 8450ab 1 - 1=ab-1 -').detail, '', 'a receipt has none');
  assert.deepEqual([answerParts('answer 4 - 2 x').names, answerParts('answer 4 - 2 x').op], ['-', '-'], 'short lines keep their dashes');
  assert.equal(answerParts('outcome stream.resumed').detail, '');
});

test('the detail reads in metres and names the bodies it means, when the copy has one row for the short id', () => {
  assert.equal(readableDetail('souls:hug: ab:7 stands 7550000 µm from its place, it steps at most 700000 µm', rows.values()),
    `souls:hug: Ada (${ada.id}) stands 7.55 m from its place, it steps at most 0.70 m`);
  assert.equal(readableDetail('cd:9 and ee:5', rows.values()), `the basket (${basket.id}) and ee:5`, 'an id the copy lacks stays as it is');
  assert.equal(readableDetail('x'.repeat(500), []).length, 400);
});

test('after an activity refusal the next step is the activity\'s: walk to the offerer or its thing, or leave first', () => {
  const r = (verb, target, reason) => ({ verbs: [verb], target, answers: [{ answer: 'refused', reason }] });
  const logged = [{ kind: 'together', what: 'offered', touch: 'hug', offer: onGround.id, from: ada.id }];
  // too far on the open ground: walk up to the Soul who offered it, never to the activity's node
  assert.deepEqual(activityTry(r('activity:accept', onGround.id, 'together.too-far'), { rows, logged }),
    { act: `walk:${ada.id}`, name: 'walk', checked: 'unknown', why: 'walk up to the Soul who offered it, then accept again' });
  // too far at a thing: walk to the thing it is played at
  assert.equal(activityTry(r('activity:accept', atBasket.id, 'together.too-far'), { rows, logged }).act, `walk:${basket.id}`);
  // any other refusal of an activity's verb: no step (not the activity node's walk)
  assert.equal(activityTry(r('activity:accept', onGround.id, 'offer-expired'), { rows, logged }), null);
  assert.equal(activityTry(r('activity:accept', onGround.id, 'together.too-far'), { rows, logged: [] }), null, 'no offerer known');
  // held by an activity: leave it first, by its id when this daemon knows it
  assert.deepEqual(activityTry(r('eden:bow', ada.id, 'resource-blocked'), { rows, logged }).command, `together leave ${onGround.id}`);
  assert.equal(activityTry(r('eden:bow', ada.id, 'resource-blocked'), { rows, logged: [] }).command, 'find activity');
  // anything else is the offers' to suggest
  assert.equal(activityTry(r('eden:sit', ada.id, 'slot-taken'), { rows, logged }), undefined);
});

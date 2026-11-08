// landing/1 (#1324, #1329 item 1): the balloon's landing words say where it really came down.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rideKind, landingWords, type RideState} from './ride.ts';

const view = (phase: string, extra: Record<string, unknown> = {}) => ({id: 'b', def: 'hot-air-balloon', label: 'Balloon', phase, holding: false, flights: 1, seatsFree: 1, capacity: 2,
  route: {seconds: 80}, door: [0, 0], departsInSeconds: null, home: [20, 0, 20], riders: [{seat: 'rider-a', entityId: 'h_1', soulId: 's_1', name: 'Ana', phase: 'seated'}], ...extra});
const ctx = (v: unknown) => ({tick: 1, now: 0, nameOf: () => 'Ana', carrier: () => v}) as never;
const texts = (s: RideState, v: unknown) => (rideKind.advance!(s, ctx(v))?.events ?? []).map(e => e.text);

test('landingWords: distance and compass from the asked point (north is -z)', () => {
  assert.equal(landingWords([0, 0], [0, -14], 'the library'), '14 m north of the library');
  assert.equal(landingWords([0, 0], [10, 0], 'the library'), '10 m east of the library');
  assert.equal(landingWords([0, 0], [1, 1], 'the library'), 'at the library');
  assert.equal(landingWords(null, [3.4, 7.6]), 'at (3, 8)');
});

test('a landing at home says so; a steered landing names the spot; neither says onto the grass', () => {
  const aloftAway = rideKind.initial({carrier: 'b'}, ctx(view('aloft', {steer: {by: null, returning: false, to: [40, 20], landAt: [40, 34], asked: [40, 20]}}))) as RideState;
  const away = texts({...aloftAway, steerLabel: 'the library'}, view('landed', {steer: {by: null, returning: false, to: [40, 34], landAt: [40, 34], asked: [40, 20]}}));
  assert.ok(away.some(t => t === 'The balloon has landed 14 m south of the library; you step out.'), JSON.stringify(away));
  const aloftHome = rideKind.initial({carrier: 'b'}, ctx(view('aloft'))) as RideState;
  const home = texts(aloftHome, view('landed'));
  assert.ok(home.some(t => t === 'The balloon has landed back where it started; you step out.'), JSON.stringify(home));
  assert.ok(![...away, ...home].some(t => /grass/.test(t)));
});

test('a landing moved on the way down tells the riders what and why', () => {
  const s = {...rideKind.initial({carrier: 'b'}, ctx(view('aloft', {steer: {by: null, returning: false, to: [40, 20], landAt: [40, 20], asked: [40, 20]}}))) as RideState, steerLabel: 'the lawn'};
  const moved = texts(s, view('aloft', {steer: {by: null, returning: false, to: [40, 31], landAt: [40, 31], asked: [40, 20]}, landNote: {tick: 9, code: 'moved', at: [40, 31], m: 11, why: 'too close to a wall'}}));
  assert.ok(moved.some(t => t === 'The landing spot is no longer clear (too close to a wall); the balloon lands 11 m south of the lawn instead.'), JSON.stringify(moved));
  const hover = texts(s, view('aloft', {landNote: {tick: 9, code: 'hover', why: 'inside or under a building (house)'}}));
  assert.ok(hover.some(t => /no clear ground to land on near the lawn .*hovers and keeps looking/.test(t)), JSON.stringify(hover));
});

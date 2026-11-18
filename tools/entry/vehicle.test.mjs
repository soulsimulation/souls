// Tests for vehicles and rides (Soul Actions SA-F14, #2884). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const load = p => { const {entry, errors} = F.parseEntry(readFileSync(root + p, 'utf8')); assert.deepEqual(errors, []); return entry; };
const cases = JSON.parse(readFileSync(new URL('./cases/vehicle.json', import.meta.url), 'utf8'));
const copy = v => structuredClone(v);
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}, got ${JSON.stringify(errors)}`);
};

test('A1: a copy of a bicycle and of a rowing boat validate as vehicles', () => {
  for (const [file, ground, drive] of [['bicycle', 'level', 'saddle'], ['rowing_boat', 'deep_water', 'oars']]) {
    const e = copy(load(`content/kinds/vehicles/${file}.json`));
    assert.deepEqual(F.validateEntry(e), []);
    assert.equal(e.vehicle.ground, ground);
    assert.equal(e.vehicle.drive, drive);
    assert.equal(e.slots[drive].posture, 'sit');
    assert.equal(e.forms[e.vehicle.steer].who, 'holder');
  }
});

test('A1: a vehicle that leaves out what Engine v2 needs is refused, at the field', () => {
  const bike = load('content/kinds/vehicles/bicycle.json');
  let e = copy(bike); e.vehicle.drive = 'nowhere'; refused(e, 'vehicle.drive', 'drive seat');
  e = copy(bike); e.slots.saddle.posture = 'lie'; refused(e, 'vehicle.drive');
  e = copy(bike); e.vehicle.speed_mm_s = 0; refused(e, 'vehicle.speed_mm_s', 'above zero');
  e = copy(bike); e.vehicle.ground = 'stairs'; refused(e, 'vehicle.ground', 'deep_water');
  e = copy(bike); delete e.geometry; refused(e, 'geometry.bounds_mm', 'size');
  e = copy(bike); e.forms.steer.who = 'anyone'; refused(e, 'vehicle.steer', 'holder');
  e = copy(bike); e.vehicle.steer = 'ride'; refused(e, 'vehicle.steer');
  e = copy(bike); e.vehicle.top_speed = 3; refused(e, 'vehicle.top_speed', 'unknown key');
  e = copy(bike); e.vehicle.speed_mm_s = 5.5; refused(e, 'vehicle.speed_mm_s', 'floating-point');
  e = copy(bike); e.ride = load('content/kinds/vehicles/sailboat.json').ride; refused(e, 'ride', 'not both');
});

test('A2: a copy of a sailboat validates as a ride with a set trip, and it has dismount cases', () => {
  const e = copy(load('content/kinds/vehicles/sailboat.json'));
  assert.deepEqual(F.validateEntry(e), []);
  assert.equal(e.vehicle, undefined);
  assert.deepEqual(e.ride.stops, ['west_landing', 'east_landing']);
  assert.equal(e.ride.returns, true);
  assert.ok(cases.dismount.some(c => c.entry.endsWith('sailboat.json')));
  let x = copy(e); x.ride.stops = ['west_landing']; refused(x, 'ride.stops', 'two or more');
  x = copy(e); x.ride.stops = ['west_landing', 'port']; refused(x, 'ride.stops.1', 'stand');
  x = copy(e); x.ride.seats = ['dock']; refused(x, 'ride.seats.0');
  x = copy(e); x.ride.returns = 'yes'; refused(x, 'ride.returns');
  x = copy(e); x.ride.start = 'nothing'; refused(x, 'ride.start');
  x = copy(e); x.forms.sail.starts = 'timer'; x.forms.sail.who = 'world'; refused(x, 'ride.start');
});

test('A3: getting off where the rider could not stand or swim, or while moving, is refused by the cases, by name', () => {
  for (const c of cases.dismount) {
    const r = F.dismount(load(c.entry), {moving: c.moving, spot: c.spot});
    assert.equal(r.ok, c.ok, `${c.entry} moving=${c.moving} spot=${c.spot}: ${JSON.stringify(r)}`);
    if (!c.ok) { assert.equal(r.code, c.code); assert.ok(r.reason.includes(c.reason_has), r.reason); }
  }
  assert.equal(F.dismount(load('content/kinds/seating/bench.json'), {moving: false, spot: 'level'}).code, 'not_a_vehicle');
  assert.equal(F.dismount(load('content/kinds/vehicles/bicycle.json'), {moving: false, spot: 'lava'}).code, 'unknown_spot');
});

test('the vehicle sections are meaning: they are in the hash; a look beside is not', () => {
  const e = load('content/kinds/vehicles/bicycle.json');
  const base = F.hashKinds([e]).get(e.kind);
  const fast = copy(e); fast.vehicle.speed_mm_s = 6000;
  assert.notEqual(F.hashKinds([fast]).get(e.kind).hash, base.hash);
  const look = copy(e); look.looks = {model: 'look:bike'};
  assert.equal(F.hashKinds([look]).get(e.kind).hash, base.hash);
});

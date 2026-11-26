import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { encode } from '../history/day.mjs';
import { decode, rememberPublicNames, rowsOf } from '../brief/copy.mjs';
import { find } from './find.mjs';
import { publicNameHydration, recordsRequest } from './public-names.mjs';

const bytes = (s) => Buffer.from(s);
const digest = (s) => createHash('sha256').update(s).digest();
function fixture(name = 'West Lake', audience = 1, counter = 1, kind = 'eden:place') {
  const ref = digest(name), raw = encode(new Map([[1, [bytes('scope'), counter]], [2, kind], [5, new Map([[1, audience]])], [6, new Map([[4, ref]])], [10, []]]));
  const hash = `1220${digest(raw).toString('hex')}`;
  return { name, ref, raw, hash };
}
function held(...records) {
  const all = new Map(records.map((r) => [r.hash, r.raw]));
  return { all, roots: () => JSON.stringify(Object.fromEntries([...all.keys()].map((h, i) => [i, h]))), record: (hash) => all.get(hash) };
}
const reply = (records, pairs = records.map((r) => [r.ref, bytes(r.name)])) => encode(new Map([[22, records.map((r) => r.raw)], ...(pairs === null ? [] : [[26, pairs]])]));

test('public immutable names reach local find; old replies and ordinary Soul/thing matches retain their behavior', () => {
  const place = fixture(), thing = fixture('Cup', 1, 2, 'eden:cup'), soul = fixture('Soul', 1, 3, 'souls:soul');
  const copy = held(place, thing, soul);
  rememberPublicNames(copy, reply([place], null));
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 0);
  const beforeThing = find(rowsOf(copy).values(), 'cup'), beforeSoul = find(rowsOf(copy).values(), 'soul');
  rememberPublicNames(copy, reply([place]));
  const found = find(rowsOf(copy).values(), 'west lake').found;
  assert.equal(found.length, 1); assert.equal(found[0].name, 'West Lake');
  assert.equal(found[0].id, '73636f7065-1');
  assert.equal('act' in found[0], false);
  assert.equal('position' in found[0], false);
  assert.deepEqual(find(rowsOf(copy).values(), 'cup'), beforeThing);
  assert.deepEqual(find(rowsOf(copy).values(), 'soul'), beforeSoul);
});

test('a malformed, private, unknown or hash-mismatched metadata batch installs nothing', () => {
  const a = fixture('Plaza'), b = fixture('Harbour', 1, 2), privatePlace = fixture('Private', 2, 3);
  for (const frame of [reply([a, b], [[a.ref, bytes(a.name)], [b.ref, bytes('wrong')]]), reply([privatePlace]), reply([a], [[b.ref, bytes(b.name)]]), reply([a], [[a.ref]])]) {
    const copy = held(a, b, privatePlace);
    assert.throws(() => rememberPublicNames(copy, frame));
    assert.equal(find(rowsOf(copy).values(), 'plaza').found.length, 0);
    assert.equal(find(rowsOf(copy).values(), 'private').found.length, 0);
  }
});

test('current record references determine names after a change or removal, without id aliases', () => {
  const a = fixture('Plaza'), b = fixture('Harbour'), copy = held(a);
  rememberPublicNames(copy, reply([a]));
  copy.all.clear(); copy.all.set(b.hash, b.raw);
  assert.equal(find(rowsOf(copy).values(), 'plaza').found.length, 0);
  assert.equal(find(rowsOf(copy).values(), 'harbour').found.length, 0);
  rememberPublicNames(copy, reply([b]));
  assert.equal(find(rowsOf(copy).values(), 'harbour').found.length, 1);
  copy.all.clear(); assert.equal(rowsOf(copy).size, 0);
});

test('same Copy hydrates through existing record hashes after old-server reconnect, once per socket', async () => {
  const a = fixture(), copy = held(a); let n = 0, current, sent = 0, upgraded = false;
  const helper = publicNameHydration(copy, () => ++n, () => current);
  const socket = () => ({ send(frame) {
    sent++; const request = decode(frame);
    assert.deepEqual(request.get(22).map((h) => Buffer.from(h).toString('hex')), [a.hash]);
    queueMicrotask(() => helper.answer(current, request.get(20), '-', reply([a], upgraded ? undefined : null)));
  } });
  current = socket();
  assert.deepEqual(await helper.hydrate(current, performance.now() + 1000), { ok: true });
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 0);
  await helper.hydrate(current, performance.now() + 1000); assert.equal(sent, 1);
  upgraded = true; current = socket();
  const first = helper.hydrate(current, performance.now() + 1000);
  assert.equal(helper.hydrate(current, performance.now() + 1000), first);
  assert.deepEqual(await first, { ok: true });
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 1);
  assert.equal(sent, 2);
  assert.throws(() => recordsRequest(1, Array(65).fill(a.hash)));
});

test('hydration matches socket and number and refuses records removed before installation', async () => {
  const a = fixture(), copy = held(a); let request;
  const sock = { send(frame) { request = decode(frame); } }, other = {};
  const helper = publicNameHydration(copy, () => 19, () => sock);
  const pass = helper.hydrate(sock, performance.now() + 1000);
  assert.equal(request.get(20), 19);
  assert.equal(helper.answer(other, 19, '-', reply([a])), false);
  assert.equal(helper.answer(sock, 20, '-', reply([a])), false);
  copy.all.clear();
  assert.equal(helper.answer(sock, 19, '-', reply([a])), true);
  assert.equal((await pass).ok, false);
  copy.all.set(a.hash, a.raw);
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 0);
});

test('hydration cancellation and total deadline retain local fallback without a retry', async () => {
  const a = fixture(), copy = held(a); let sent = 0;
  const sock = { send() { sent++; } }, helper = publicNameHydration(copy, () => 1, () => sock);
  const pass = helper.hydrate(sock, performance.now() + 1000); helper.cancel(sock);
  assert.equal((await pass).reason, 'public-names-disconnected');
  assert.equal((await helper.hydrate(sock, performance.now() - 1)).reason, 'public-names-timeout');
  assert.equal(sent, 1);
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 0);
});

test('overlapping A to B socket replacement finishes A and isolates both promises and timers', { timeout: 1000 }, async () => {
  const a = fixture(), copy = held(a); let current, n = 0;
  const requests = new Map(), socket = () => ({ send(frame) { requests.set(this, decode(frame).get(20)); } });
  const firstSocket = socket(), secondSocket = socket();
  const helper = publicNameHydration(copy, () => ++n, () => current);
  current = firstSocket;
  const first = helper.hydrate(firstSocket, performance.now() + 500);
  current = secondSocket;
  const second = helper.hydrate(secondSocket, performance.now() + 500);
  assert.equal((await first).reason, 'public-names-disconnected');
  helper.cancel(firstSocket);
  assert.equal(await Promise.race([second, Promise.resolve('pending')]), 'pending');
  assert.equal(helper.answer(firstSocket, requests.get(firstSocket), '-', reply([a])), false);
  assert.equal(helper.answer(secondSocket, requests.get(secondSocket), '-', reply([a])), true);
  assert.deepEqual(await second, { ok: true });
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 1);
});

test('a changed root refuses hydration before any name installation', async () => {
  const a = fixture('Plaza'), b = fixture('Harbour'), copy = held(a);
  const sock = { send() {} }, helper = publicNameHydration(copy, () => 1, () => sock);
  const pass = helper.hydrate(sock, performance.now() + 1000);
  // The old canonical record may still be held during a descent; its old public root is no longer current.
  const roots = copy.roots; copy.all.set(b.hash, b.raw);
  copy.roots = () => JSON.stringify({ changed: b.hash });
  helper.answer(sock, 1, '-', reply([a]));
  assert.equal((await pass).reason, 'public-names-changed');
  copy.roots = roots;
  assert.equal(find(rowsOf(copy).values(), 'plaza').found.length, 0);
});

test('multiple batches read the reachable copy once, then only their expected records', async () => {
  const records = Array.from({ length: 130 }, (_, i) => fixture(`Place ${i}`, 1, i + 1));
  const copy = held(...records), byHash = new Map(records.map((r) => [r.hash, r]));
  let reads = 0, requests = 0, number = 0;
  const read = copy.record; copy.record = (hash) => { reads++; return read(hash); };
  const sock = { send(frame) {
    requests++; const ask = decode(frame), hashes = ask.get(22);
    assert.ok(hashes.length <= 64);
    const batch = hashes.map((h) => byHash.get(Buffer.from(h).toString('hex')));
    queueMicrotask(() => helper.answer(sock, ask.get(20), '-', reply(batch)));
  } };
  const helper = publicNameHydration(copy, () => ++number, () => sock);
  assert.deepEqual(await helper.hydrate(sock, performance.now() + 1000), { ok: true });
  assert.equal(requests, 3);
  // The rows read once, then the bytes of the records still missing a name, then each answer's: the copy is not walked
  // again for each batch.
  assert.equal(reads, 3 * records.length);
  reads = 0;
  assert.deepEqual(await helper.hydrate(sock, performance.now() + 1000), { ok: true });
  assert.equal(requests, 3, 'every name known: nothing asked again');
  assert.equal(reads, 0, 'and no record read again');
});

test('synchronous validation past the original deadline cannot report a fresh success', async (t) => {
  let now = 0, late = false;
  t.mock.method(performance, 'now', () => now);
  const a = fixture(), copy = held(a), read = copy.record;
  copy.record = (hash) => { if (late) now = 1001; return read(hash); };
  const sock = { send() {} }, helper = publicNameHydration(copy, () => 1, () => sock);
  const pass = helper.hydrate(sock, 1000); late = true;
  helper.answer(sock, 1, '-', reply([a]));
  assert.equal((await pass).reason, 'public-names-timeout');
  assert.equal(find(rowsOf(copy).values(), 'west lake').found.length, 0);
});

// Engine v2 E26 (#3329): `converse`'s words, the intents each sends, the events that tell a Soul of an invitation
// or a decline, and the offer's parameters as replica's WASM puts them on the wire. Run from v2/ after building
// replica's wasm-bindgen package in target/wasm-load/pkg (tools/ci.sh's wasm-bindgen step).

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_PKG } from '../daemon/client.mjs';
import { KIND, MEMBER, OPENER, converseIntents, offerNote } from '../converse/converse.mjs';
import { requestOf } from './souls.mjs';

const S = 'ab'.repeat(16);
const [me, other, place, conv] = [`${S}-2`, `${S}-3`, `${S}-1`, `${S}-9`];
const ctx = { ns: 'eden', place };

test('the command words: start, accept, decline, say (public and private), leave, list', () => {
  assert.deepEqual(requestOf(['converse', 'start', other, 'got', 'a', 'minute?']).req,
    { op: 'converse', do: 'start', with: other, words: 'got a minute?' });
  assert.deepEqual(requestOf(['converse', 'start', other, 'just us', '--private']).req,
    { op: 'converse', do: 'start', with: other, words: 'just us', private: true });
  for (const d of ['accept', 'decline', 'leave']) {
    assert.deepEqual(requestOf(['converse', d, conv]).req, { op: 'converse', do: d, conversation: conv });
  }
  assert.deepEqual(requestOf(['converse', 'say', conv, 'hello', '--private']).req,
    { op: 'converse', do: 'say', conversation: conv, words: 'hello', private: true });
  assert.deepEqual(requestOf(['converse']).req, { op: 'converse', do: 'list' });
});

test('start offers the conversation and gives the opening line to the body asked alone', () => {
  assert.deepEqual(converseIntents({ do: 'start', with: other, words: 'got a minute?' }, ctx), [
    { verb: 'activity:offer', target: place, params: { 1: KIND, 2: OPENER, 3: [other] } },
    { verb: 'eden:whisper', target: other, words: 'got a minute?' },
  ]);
  assert.equal(converseIntents({ do: 'start', with: 'Bob' }, ctx).code, 'converse-names-a-body');
  assert.equal(converseIntents({ do: 'start', with: other }, { ns: 'eden', place: null }).code, 'converse-no-place');
});

test('accept, decline and leave name the conversation; a turn is public unless private', () => {
  for (const d of ['accept', 'decline', 'leave']) {
    assert.deepEqual(converseIntents({ do: d, conversation: conv }, ctx), [{ verb: `activity:${d}`, target: conv }]);
  }
  assert.deepEqual(converseIntents({ do: 'say', conversation: conv, words: 'hi all' }, ctx), [{ verb: 'eden:say', words: 'hi all' }]);
  assert.deepEqual(converseIntents({ do: 'say', conversation: conv, words: 'just us', private: true }, ctx),
    [{ verb: 'eden:say', target: conv, words: 'just us' }]);
  assert.deepEqual(converseIntents({ do: 'say', conversation: conv, words: 'still us' }, { ...ctx, privateOf: (id) => id === conv }),
    [{ verb: 'eden:say', target: conv, words: 'still us' }], 'a conversation made private stays so');
  assert.equal(converseIntents({ do: 'say', conversation: conv, words: ' ' }, ctx).code, 'words-empty-or-long');
  assert.equal(converseIntents({ do: 'dance' }, ctx).code, 'converse-unknown');
  assert.equal(MEMBER, 'souls:member');
});

test('an invitation reaches the body asked; a decline or a lapse is named to the opener', () => {
  const ev = (name) => ({ name, fields: name === 'souls:offer' ? { 1: conv, 2: KIND, 3: [me], 4: 60_000_000, 5: other } : { 1: conv, 2: other, 3: [me] } });
  assert.deepEqual(offerNote(ev('souls:offer'), me), { kind: 'conversation', what: 'invited', conversation: conv, from: other });
  assert.equal(offerNote(ev('souls:offer'), other), null, 'its own offer is no invitation');
  assert.deepEqual(offerNote(ev('souls:offer-declined'), other), { kind: 'conversation', what: 'declined', conversation: conv });
  assert.deepEqual(offerNote(ev('souls:offer-lapsed'), other), { kind: 'conversation', what: 'lapsed', conversation: conv });
  assert.equal(offerNote(ev('souls:offer-declined'), me), null, 'another opener\'s decline');
  assert.equal(offerNote({ name: 'souls:said', fields: {} }, me), null);
});

test('the offer\'s parameters on the wire: the kind and role as names, the bodies asked as ids', async () => {
  const pkg = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
  const wire = await import(pathToFileURL(join(pkg, 'replica.js')).href);
  wire.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
  const [offer] = converseIntents({ do: 'start', with: other }, ctx);
  const send = (params) => wire.wireIntent(Buffer.from(S, 'hex'), 2n, offer.verb, 1n, new Uint8Array(), 9n, offer.target,
    undefined, undefined, params);
  const bytes = Buffer.from(send(JSON.stringify(offer.params)));
  const plain = Buffer.from(send(undefined));
  // The parameters as the world reads them (`worldd::engine`): 1 and 2 names, 3 a list of ids.
  const p = Buffer.from(wire.encode_diagnostic(`{1: "${KIND}", 2: "${OPENER}", 3: [[h'${S}', 3]]}`));
  assert.ok(bytes.includes(p.subarray(1)), 'the parameters map, encoded as the world reads it');
  assert.ok(bytes.length > plain.length && !plain.includes(Buffer.from(KIND)));
  assert.throws(() => send('{"one": 1}'), /params-not-numbered/);
  assert.throws(() => send('{"1": {"a": 1}}'), /param-unsupported/);
});

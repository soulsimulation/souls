// #4535: an open page on a v2 world reloads for a stream format its bundle cannot read, and only then (stream-format.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'cborg';
import { RELOAD_AGAIN_MS, RELOAD_NOTICE_MS, STREAM_FORMATS, formatOf, reloadForFormat, unreadFormat } from './stream-format.ts';
import { V2Bridge } from './bridge.ts';
import { STREAM_NOTICE, STREAM_RELOADING, streamNotice } from './stream-health.ts';

// A baseline as the replica writes it: canonical CBOR, field 1 its format (replica::stream::public `baseline`).
const baseline = (format: number, extra: [number, unknown][] = []) =>
  encode(new Map<number, unknown>([[1, format], [2, new Uint8Array(32)], [3, new Map([[1, 9]])], [4, 7], ...extra]));

test('a baseline names its format in its first bytes, whole or as a ranged head', () => {
  assert.deepEqual(STREAM_FORMATS, [1]);
  for (const f of [1, 2, 23, 24, 255, 256, 4000]) {
    assert.equal(formatOf(baseline(f)), f);
    assert.equal(formatOf(baseline(f).slice(0, 16)), f);
  }
  assert.equal(formatOf(encode(new Map([[3, new Map([[1, 9]])]]))), null, 'no field 1: none named');
  assert.equal(formatOf(encode([1, 2])), null, 'not a map');
  assert.equal(formatOf(new Uint8Array()), null);
});

test('a compatible stream is read: the same format, or the same with a field this page does not know (R16 field 5)', () => {
  assert.equal(unreadFormat(baseline(1)), null);
  assert.equal(unreadFormat(baseline(1, [[5, 3]])), null);
  assert.equal(unreadFormat(baseline(2)), 2);
  assert.equal(unreadFormat(baseline(0)), 0, 'one older than this page reads is not read either');
});

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

test('the page reloads after its notice, at most once a minute for one format, never without session storage', () => {
  const s = store(), reloads: number[] = [];
  const at = (now: number) => reloadForFormat(2, { store: s, now, reload: () => reloads.push(now), later: (f, ms) => { assert.equal(ms, RELOAD_NOTICE_MS); f(); } });
  assert.equal(at(1_000), true);
  assert.equal(at(1_000 + RELOAD_AGAIN_MS - 1), false, 'the new bundle is not served yet: no loop');
  assert.equal(at(1_000 + RELOAD_AGAIN_MS), true, 'a minute later, it tries again');
  assert.deepEqual(reloads, [1_000, 1_000 + RELOAD_AGAIN_MS]);
  assert.equal(reloadForFormat(3, { store: s, now: 1_000 + RELOAD_AGAIN_MS, reload: () => reloads.push(-1), later: (f) => f() }), true, 'another format');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
  assert.equal(reloadForFormat(2, { store: broken, reload: () => assert.fail('reloaded'), later: (f) => f() }), false);
});

test('the bridge reloads for a format it cannot read and shows the notice; a compatible stream runs on', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const asked: number[] = [];
  let allow = false;
  b.reloadFor = (f) => (asked.push(f), allow);
  // compatible: a snapshot and a part, no reload
  b.receive({ t: 'snapshot', s: { nodes: [], removed: [] } });
  b.receive({ t: 'part', p: { number: 0, from: 0, to: 500_000, nodes: [], removed: [], samples: [] } as never });
  assert.deepEqual(asked, []);
  assert.equal(b.view.reloading, undefined);
  // a reload refused (one a minute ago) is asked again at the next try; one allowed is asked once
  b.receive({ t: 'format', format: 2 });
  b.receive({ t: 'error', message: 'stream-format 2' });
  assert.equal(b.view.reloading, undefined);
  allow = true;
  b.receive({ t: 'format', format: 2 });
  b.receive({ t: 'format', format: 2 });
  assert.deepEqual(asked, [2, 2]);
  assert.equal(b.view.reloading, 2);
  const h = { failed: false, error: b.view.error, errorAtParts: b.view.parts, parts: b.view.parts, startedAt: 0, lastPartAt: 0, now: 1 };
  assert.equal(streamNotice({ ...h, reloading: true }), STREAM_RELOADING);
  assert.equal(streamNotice(h), STREAM_NOTICE);
});

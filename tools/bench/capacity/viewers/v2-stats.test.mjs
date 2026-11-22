// #4018: the v2 viewers bench's pure helpers. Run: node --test tools/bench/capacity/viewers/v2-stats.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bars, cbor, fileType, hq, idText, procCpuSeconds, psSeconds, record, walkTargets } from './v2-stats.mjs';

test('cbor reads maps, arrays, bytes, text and simple values', () => {
  // {1: [h'0102', 7], 2: "a", 3: true, 4: null}
  const v = cbor(Uint8Array.from([0xa4, 0x01, 0x82, 0x42, 1, 2, 0x07, 0x02, 0x61, 0x61, 0x03, 0xf5, 0x04, 0xf6]));
  assert.deepEqual([...v.get(1)[0]], [1, 2]);
  assert.equal(v.get(1)[1], 7);
  assert.equal(v.get(2), 'a');
  assert.equal(v.get(3), true);
  assert.equal(v.get(4), null);
  assert.equal(idText(v.get(1)), '0102-7');
  assert.equal(idText('x'), null);
});

test('walk targets are the open ground\'s children, bodies left out', () => {
  // [{1: [h'aa', 1], 2: "k:ground", 3: [h'aa', 0]}, {1: [h'aa', 2], 2: "k:tree", 3: [h'aa', 1]},
  //  {1: [h'aa', 3], 2: "k:bench", 3: [h'aa', 1]}, {1: [h'aa', 4], 2: "souls:body", 3: [h'aa', 1]}]
  const node = (n, kind, parent) => [0xa3, 0x01, 0x82, 0x41, 0xaa, n, 0x02, 0x60 + kind.length, ...Buffer.from(kind), 0x03, 0x82, 0x41, 0xaa, parent];
  const snap = Uint8Array.from([0x84, ...node(1, 'k:ground', 0), ...node(2, 'k:tree', 1), ...node(3, 'k:bench', 1), ...node(4, 'souls:body', 1)]);
  assert.deepEqual(walkTargets(snap), ['aa-2', 'aa-3']);
});

test('file types', () => {
  assert.equal(fileType('/a/b/pointer'), 'pointer');
  assert.equal(fileType('/l/z/0/headers/1220ab'), 'header');
  assert.equal(fileType('/s/g/ff/baseline'), 'baseline');
  assert.equal(fileType('/s/g/ff/baseline.text'), 'baseline.text');
  assert.equal(fileType('/s/g/ff/12'), 'part');
  assert.equal(fileType('/s/g/ff/12.text'), 'part.text');
});

test('histogram quantiles are bucket tops', () => {
  const h = {};
  for (const ms of [5, 15, 25, 35, 2500]) record(h, ms);
  assert.equal(hq(h, 0.5), 30);
  assert.equal(hq(h, 0.99), 2510);
  assert.equal(hq({}, 0.5), null);
});

test('bars: met, missed, and the tick floor', () => {
  const row = { viewers: 100, firstPictureP95: 3500, latencyP99: 400, errors: 0, reinstalls: 0, behind: 0, originRestarts: 1, originRssMaxMb: 120, originCores: 0.2, tickMeanUs: 160 };
  const met = Object.fromEntries(bars(row, 100).map((b) => [b.bar.split(' ')[0], b.met]));
  assert.deepEqual(met, { B1: false, B2: true, B3: false, B4: true, B5: true, B6: true }); // +60 µs: under the 0.5 ms floor
  assert.equal(bars({ ...row, tickMeanUs: 1200 }, 600).at(-1).met, false);
  assert.equal(bars({ ...row, firstPictureP95: 100, waitingAtEnd: 3 }, 100)[0].met, false); // joiners still waiting
});

test('processor time readers', () => {
  assert.equal(procCpuSeconds('42 (node (x)) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0'), 3);
  assert.equal(psSeconds('01:02:03'), 3723);
  assert.equal(psSeconds('1-00:00:01.50'), 86401.5);
});

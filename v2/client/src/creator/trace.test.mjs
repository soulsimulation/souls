// `souls-god trace [n]` (kept for 0.131): the creator daemon's ring of recent commands, refused or not, and the words
// that ask for it. No world is needed: the ring is the daemon's own.

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requestOf } from './souls-god.mjs';
import { TRACE_MOST, openCreatorTrace, rowOf, verbOf } from './trace.mjs';

test('trace [n] asks the daemon for the last n, 20 by default, 1 to 200', () => {
  assert.deepEqual(requestOf(['trace']).req, { op: 'trace', n: 20 });
  assert.deepEqual(requestOf(['trace', '5']).req, { op: 'trace', n: 5 });
  for (const bad of [['trace', '0'], ['trace', '201'], ['trace', 'x'], ['trace', '2', '3']]) assert.throws(() => requestOf(bad), /trace \[n\]/, bad.join(' '));
});

test('a row names the verb as the creator typed it, its result and a refusal\'s code, op and reason', () => {
  assert.equal(verbOf({ op: 'edit', ops: [{ op: 'place' }] }), 'place');
  assert.equal(verbOf({ op: 'edit', ops: [{ op: 'place' }, { op: 'set' }] }), 'batch');
  assert.equal(verbOf({ op: 'edit', world: { verb: 'time', hour: '18:30' } }), 'time');
  assert.equal(verbOf({ op: 'check', world: { verb: 'sky' } }), 'check sky');
  assert.equal(verbOf({ op: 'describe' }), 'describe');
  const at = new Date(Date.UTC(2026, 10, 21, 20, 0));
  assert.deepEqual(rowOf({ op: 'edit', ops: [{ op: 'set' }] }, { ok: true, sequence: 7 }, at), { at: '2026-11-21T20:00:00.000Z', verb: 'set', ok: true, sequence: 7 });
  assert.deepEqual(rowOf({ op: 'check', ops: [{ op: 'place' }] }, { ok: false, code: 'edit.child-not-admitted', op: 0, detail: 'x'.repeat(500), local: true }, at),
    { at: '2026-11-21T20:00:00.000Z', verb: 'check place', ok: false, code: 'edit.child-not-admitted', op: 0, detail: 'x'.repeat(200), local: true });
});

test('the ring keeps the last 200, newest first, and a restart reads them back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-trace-'));
  try {
    const ring = openCreatorTrace(dir);
    for (let i = 0; i < TRACE_MOST + 30; i++) ring.add({ at: String(i), verb: 'place', ok: i % 2 === 0 });
    assert.equal(ring.size, TRACE_MOST);
    assert.deepEqual(ring.last(3).map((r) => r.at), ['229', '228', '227']);
    assert.equal(ring.last(1000).length, TRACE_MOST);
    assert.equal(ring.last(1000).at(-1).at, '30', 'the oldest kept is the 31st');
    const again = openCreatorTrace(dir);
    assert.equal(again.size, TRACE_MOST);
    assert.deepEqual(again.last(2), ring.last(2));
    assert.equal(JSON.parse(readFileSync(join(dir, 'creator-trace.json'), 'utf8')).rows.length, TRACE_MOST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged file starts an empty ring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-trace-'));
  try {
    const ring = openCreatorTrace(dir);
    ring.add({ at: '1', verb: 'set', ok: true });
    writeFileSync(join(dir, 'creator-trace.json'), '{not json');
    assert.equal(openCreatorTrace(dir).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #1774: a run's full record and #1752's measures read from it (record.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeOf, traceFromRecord, lookupStats, lookupEmpty, windowsOf, measureWindow, itemFor, finishRunRecord, recordRows, recordOn } from './record.mjs';

const T0 = Date.parse('2026-11-10T12:00:00Z');
const V = 'soul-trace/2';
let seq = 0;
const proc = (command, at, ms, stdout) => { const p = `p${++seq}`; return [{ v: V, kind: 'proc.start', proc: p, at, command }, { v: V, kind: 'proc.end', proc: p, at: at + ms, wallStart: at, ms, stdout }]; };
const http = (at, method, path, status, ms, world, res, extra = {}) => ({ v: V, kind: 'http', at: at + ms, wallStart: at, method, path, status, ms, server: world == null ? undefined : { world, queue: 0 }, res, ...extra });

// The A9 shape: "Sit down" took six empty local lookups, then an act refused once and accepted on its alternative.
const rows = [
  ...proc('look', T0 + 1000, 300, '{"me":{}}'),
  ...[0, 1, 2, 3, 4, 5].flatMap((i) => proc('find', T0 + 2000 + i * 4000, 200, JSON.stringify({ found: [], next: 'Nothing here is called that.' }))),
  ...proc('act', T0 + 27000, 1200, '{"accepted":false}'),
  http(T0 + 27000, 'POST', '/v1/edge/act', 200, 900, 850, { accepted: false, error: { code: 'act.not-an-id' } }, { key: 'op_1' }),
  http(T0 + 29500, 'POST', '/v1/edge/act', 200, 300, 240, { accepted: true, receipt: { id: 'rcpt_1' } }, { ids: { receipts: ['rcpt_1'] } }),
  http(T0 + 30000, 'GET', '/v1/edge/wait?timeoutMs=30000', 200, 4000, 1, { events: [] }),
  { v: V, kind: 'wire', at: T0 + 30500, wallStart: T0 + 30500, method: 'GET', path: '/v1/edge/inbox/listen', status: 200, ms: 50 },
  http(T0 + 31000, 'GET', '/v1/edge/look', 200, 40, 12, {}, { proxied: true }),
  // a second instruction's window
  ...proc('find', T0 + 61000, 150, JSON.stringify({ found: [{ id: 'g-eden-bandstand' }] })),
  http(T0 + 62000, 'POST', '/v1/edge/act', 200, 200, 120, { accepted: true, receipt: { id: 'rcpt_2' } }),
];

test('the record\'s world calls feed #1752\'s measures in their shape; serve\'s own and proxied calls are not the agent\'s', () => {
  const t = traceFromRecord(rows);
  assert.equal(t.length, 4);
  assert.deepEqual(t[0], { v: 'soul-trace/1', kind: 'http', at: T0 + 27000, method: 'POST', route: '/v1/edge/act', status: 200, durationMs: 900, serverMs: 850, queueMs: 0, key: 'op_1', ids: null, facts: { accepted: false, code: 'act.not-an-id' } });
  assert.deepEqual(t[1].facts, { accepted: true });
});

test('empty local lookups: count and the stretch they took (#1773 A9: six for "Sit down")', () => {
  assert.equal(lookupEmpty('find', '{"found":[]}'), true);
  assert.equal(lookupEmpty('find', '{"found":[{"id":"x"}]}'), false);
  assert.equal(lookupEmpty('query', JSON.stringify({ answers: [{ places: [] }, { acts: [] }] })), true);
  assert.equal(lookupEmpty('query', JSON.stringify({ answers: [{ places: [{ id: 'p' }] }] })), false);
  assert.equal(lookupEmpty('find', { cut: true, bytes: 1, head: '' }), null);
  const s = lookupStats(rows, T0, T0 + 60000);
  assert.equal(s.lookups, 6); assert.equal(s.empty, 6);
  assert.deepEqual(s.emptyStretches, [{ lookups: 6, empty: 6, ms: 20200 }]);
  assert.equal(s.longestEmptyStretchMs, 20200);
  assert.deepEqual(lookupStats(rows, T0 + 60000), { lookups: 1, empty: 0, emptyStretches: [], longestEmptyStretchMs: 0 });
});

const battery = { battery: 'b', items: [{ id: 'sit-down', instruction: 'Sit down.', check: { posture: 'seated' } }, { id: 'bandstand', instruction: 'Walk to the bandstand.', check: { place: ['g-eden-bandstand'] } }] };
const snap = (t, place, posture, receipts = []) => ({ t: new Date(t).toISOString(), place, placeIds: [place], bodyPosture: posture, receipts });
const evidence = [
  { requestId: 'sol-001', seat: 'sol', text: 'sit down', channel: 'chat', sentAt: new Date(T0).toISOString(), cutoffAt: new Date(T0 + 50000).toISOString(), cutoffReason: 'turn-complete', firstBodyChangeAt: new Date(T0 + 31000).toISOString(),
    samples: [snap(T0 + 500, 'field', 'standing'), snap(T0 + 45000, 'field', 'seated', [{ id: 'rcpt_1', phase: 'started', capability: 'sit-ground:here' }])], receipts: [{ id: 'rcpt_1', phase: 'started', capability: 'sit-ground:here' }] },
  { requestId: 'sol-002', seat: 'sol', text: 'Walk to the bandstand!', channel: 'card', sentAt: new Date(T0 + 60000).toISOString(), cutoffAt: new Date(T0 + 90000).toISOString(), cutoffReason: 'result', resultState: 'done', resultAt: 'x', ackAt: 'y',
    samples: [snap(T0 + 60500, 'field', 'seated'), snap(T0 + 80000, 'g-eden-bandstand', 'standing')], receipts: [] },
  { requestId: 'sol-003', seat: 'sol', text: 'nice!', channel: 'chat', sentAt: new Date(T0 + 95000).toISOString(), cutoffAt: new Date(T0 + 99000).toISOString(), samples: [], receipts: [] },
];

test('instruction windows run from one owner message to the next; each is judged by #1752\'s check on world truth, never the agent\'s words', () => {
  const w = windowsOf(evidence);
  assert.deepEqual(w.map((x) => [x.since - T0, x.until - T0]), [[0, 60000], [60000, 95000], [95000, 99001]]);
  assert.equal(itemFor(battery, ' walk to the Bandstand '), battery.items[1]);
  const trace = traceFromRecord(rows), server = [{ at: T0 + 27010, path: '/w/x/v1/edge/act', key: 'op_1', worldMs: 850, queueMs: 0 }, { at: T0 + 29510, path: '/w/x/v1/edge/act', receipts: ['rcpt_1'], worldMs: 240, queueMs: 2 },
    { at: T0 + 30000, path: '/w/x/v1/edge/wait', key: 'op_1', worldMs: 4000 }, { at: T0 + 31000, path: '/w/x/v1/edge/public/souls/s_1', worldMs: 3 }];
  const e1 = measureWindow({ win: w[0], trace, server, rows, battery });
  assert.equal(e1.item, 'sit-down'); assert.equal(e1.succeeded, true); assert.equal(e1.judged, true);
  assert.equal(e1.firstMotionMs, 31000); assert.equal(e1.worldCalls, 2); assert.equal(e1.longPolls, 1);
  assert.deepEqual(e1.refusals, { 'act.not-an-id': 1 });
  assert.equal(e1.lookups.empty, 6);
  assert.deepEqual(e1.serverRecord, { requests: 2, worldMsP50: 240, worldMsMax: 850, queueMsMax: 2 });
  const e2 = measureWindow({ win: w[1], trace, rows, battery });
  assert.equal(e2.item, 'bandstand'); assert.equal(e2.succeeded, true); assert.equal(e2.card.closed, true); assert.equal(e2.serverRecord, null);
  const e3 = measureWindow({ win: w[2], trace, rows, battery });
  assert.equal(e3.judged, false); assert.equal(e3.item, 'sol-003');
});

test('finishRunRecord: per seat a collected bundle, the persona, evidence and world logs named in record.json; MEASURES.md is #1752\'s report', async () => {
  const run = mkdtempSync(join(tmpdir(), 'pt-record-'));
  const seatDir = join(run, 'seats', 'sol'), folder = join(seatDir, 'folder');
  mkdirSync(folder, { recursive: true }); mkdirSync(join(run, 'evidence')); mkdirSync(join(run, 'server')); mkdirSync(join(run, 'personas', 'sol'), { recursive: true });
  for (const e of evidence) writeFileSync(join(run, 'evidence', `${e.requestId}.json`), JSON.stringify(e));
  writeFileSync(join(run, 'server', 'world.log'), 'boot\n');
  writeFileSync(join(run, 'server', 'requests.jsonl'), JSON.stringify({ v: 'world-request/1', at: T0 + 27010, worldMs: 850, queueMs: 0 }) + '\n');
  writeFileSync(join(run, 'personas', 'sol', 'turns.jsonl'), '{}\n');
  writeFileSync(join(seatDir, 'turns.jsonl'), JSON.stringify({ turn: 1, reason: 'chat', startedAt: new Date(T0 + 100).toISOString(), wallMs: 30000, usage: { inputTokens: 10, cachedTokens: 0, cacheCreationTokens: 0, outputTokens: 5, costUsd: 0.01 } }) + '\n');
  writeFileSync(join(seatDir, 'transcript.jsonl'), JSON.stringify({ turn: 1, type: 'assistant', message: { id: 'm1', usage: {}, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node eden.mjs find "a seat"' } }] } }) + '\n');
  const calls = [];
  const collect = async ({ folder: f, out, claudeDirs }) => { calls.push({ f, claudeDirs }); mkdirSync(join(out, 'client'), { recursive: true }); writeFileSync(join(out, 'manifest.json'), '{"private":true}'); writeFileSync(join(out, 'client', 'record.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); return { ok: true, records: rows.length, transcripts: 1 }; };
  const r = await finishRunRecord({ runDir: run, seats: [{ id: 'sol', folder, dir: seatDir, soulId: 's_1' }], scenario: { name: 'sit', battery }, world: {}, claudeDirs: ['/cfg'], collect });
  assert.deepEqual(calls, [{ f: folder, claudeDirs: ['/cfg'] }]);
  const idx = JSON.parse(readFileSync(join(run, 'record.json'), 'utf8'));
  assert.equal(idx.private, true);
  assert.equal(idx.world.log, 'server/world.log'); assert.equal(idx.world.requests, 'server/requests.jsonl');
  const s = idx.seats[0];
  assert.equal(s.bundle, 'seats/sol/record'); assert.equal(s.records, rows.length);
  assert.equal(s.persona.transcript, 'personas/sol/turns.jsonl'); assert.deepEqual(s.evidence, ['evidence/sol-001.json', 'evidence/sol-002.json', 'evidence/sol-003.json']);
  assert.equal(idx.episodes.length, 3);
  const md = readFileSync(join(run, 'MEASURES.md'), 'utf8');
  assert.match(md, /^# Soul Client eval/); assert.match(md, /\*\*Succeeded 2 of 2\.\*\*/, 'the report counts the battery messages it judged');
  assert.match(md, /## Run facts \(#1774\)/); assert.match(md, /\| sol-003 \| sol-003 \| not judged \|/);
  assert.equal(r.result.episodes[0].seat.modelTurns, 1);
  // a failed collect is named, not fatal
  const run2 = mkdtempSync(join(tmpdir(), 'pt-record-'));
  const r2 = await finishRunRecord({ runDir: run2, seats: [{ id: 'x', folder, dir: seatDir }], collect: async () => ({ ok: false, error: 'No session record' }) });
  assert.equal(r2.index.seats[0].bundle, null); assert.equal(r2.index.seats[0].bundleError, 'No session record');
});

test('recordOn: the folder itself for a plain Soul folder, .souls/ for a home; recordRows reads rolled files in time order', () => {
  const f = mkdtempSync(join(tmpdir(), 'pt-rec-'));
  assert.equal(recordOn(f), join(f, '.eden-record-on'));
  const h = mkdtempSync(join(tmpdir(), 'pt-rec-')); mkdirSync(join(h, '.souls')); writeFileSync(join(h, '.souls', 'config.json'), '{}');
  assert.equal(recordOn(h), join(h, '.souls', '.eden-record-on')); assert.ok(!existsSync(join(h, '.eden-record-on')));
  const d = mkdtempSync(join(tmpdir(), 'pt-rec-'));
  writeFileSync(join(d, 'record.jsonl'), JSON.stringify({ v: V, at: 3 }) + '\n' + JSON.stringify({ v: 'other', at: 0 }) + '\n');
  writeFileSync(join(d, 'record-1-ab12.jsonl'), JSON.stringify({ v: V, at: 1 }) + '\n');
  writeFileSync(join(d, 'serve.log'), 'x\n');
  assert.deepEqual(recordRows(d).map((r) => r.at), [1, 3]);
});

test('a route keeps no world prefix and no query values (one route per listen, not one per cursor)', () => {
  assert.equal(routeOf('/w/pt-x/v1/edge/inbox/listen?timeoutMs=50000&after=msg_1'), '/v1/edge/inbox/listen?timeoutMs&after');
  assert.equal(routeOf('/v1/edge/act'), '/v1/edge/act');
  assert.equal(routeOf(undefined), '');
});

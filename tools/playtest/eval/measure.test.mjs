import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normRoute, isLongPoll, serviceLevel, routeStats, refusalCounts, cliCommand, seatStats, observe, judge, validateBattery, catalogIndex, summarize, quantile, httpSince } from './measure.mjs';

const cat = catalogIndex({ places: [{ id: 'g-eden-windmill', kind: 'mill' }, { id: 'g-eden-bandstand', kind: 'building' }, { id: 'field', kind: 'walkable' }, { id: 'g-eden-library-1', kind: 'building' }, { id: 'g-region-campus-library-annex', kind: 'building' }, { id: 'g-place-social-eden-fire-circle', kind: 'zone' }, { id: 'g-land-west-lake-jetty', kind: 'jetty' }, { id: 'g-land-west-lake.shore-bank', kind: 'shore' }, { id: 'g-land-west-lake', kind: 'water' }],
  things: [{ id: 'e_bench1', kind: 'core-bench' }, { id: 'e_chair', kind: 'core-chair' }] });

test('routes: ids fold, long polls and levels are told apart', () => {
  assert.equal(normRoute('/v1/edge/receipts/r_8cb0221e-d6a4-4b53-b77e-5ca5e9394887'), '/v1/edge/receipts/:id');
  assert.equal(normRoute('/v1/edge/owner/s_3f59afedf4/inbox'), '/v1/edge/owner/:id/inbox');
  assert.equal(normRoute('/v1/edge/act'), '/v1/edge/act');
  assert.equal(normRoute('/v1/edge/inbox/msg_ea49fe30-1231-4a7a/ack'), '/v1/edge/inbox/:id/ack');
  assert.ok(isLongPoll('/v1/edge/wait?after&timeout'));
  assert.ok(isLongPoll('/v1/edge/inbox/listen?timeoutMs'));
  assert.ok(!isLongPoll('/v1/edge/act'));
  assert.deepEqual(serviceLevel('POST', '/v1/edge/act'), { kind: 'act', ms: 150 });
  assert.deepEqual(serviceLevel('GET', '/v1/edge/receipts/:id'), { kind: 'read', ms: 100 });
  assert.deepEqual(serviceLevel('POST', '/v1/edge/inbox/ack'), { kind: 'bookkeeping', ms: 50 });
  assert.equal(serviceLevel('GET', '/v1/edge/wait?after&timeout'), null);
});

test('route stats and refusals from a soul-trace/1 trace', () => {
  const tr = [
    { v: 'soul-trace/1', kind: 'proc.start', at: 1 },
    { v: 'soul-trace/1', kind: 'http', at: 10, method: 'POST', route: '/v1/edge/act', status: 200, durationMs: 218, serverMs: 212, facts: { accepted: true } },
    { v: 'soul-trace/1', kind: 'http', at: 11, method: 'POST', route: '/v1/edge/act', status: 200, durationMs: 20, serverMs: 12, facts: { accepted: false, code: 'capability.unknown' } },
    { v: 'soul-trace/1', kind: 'http', at: 12, method: 'GET', route: '/v1/edge/wait?after&timeout', status: 200, durationMs: 21000, serverMs: 20990 },
    { v: 'soul-trace/1', kind: 'http', at: 13, method: 'GET', route: '/v1/edge/receipts/r_1', status: 404, durationMs: 3, serverMs: 1, facts: { code: 'receipt.unknown' } },
    { v: 'soul-trace/1', kind: 'http', at: 2, method: 'GET', route: '/v1/edge/receipts/r_0', status: 200, durationMs: 3, serverMs: 1 },
  ];
  const http = httpSince(tr, 5);
  assert.equal(http.length, 4);
  const rs = routeStats(http), act = rs.find((x) => x.route === 'POST /v1/edge/act');
  assert.equal(act.n, 2); assert.equal(act.overLevel, 1); assert.equal(act.serverMs.max, 212); assert.equal(act.level, 'act');
  assert.equal(rs.find((x) => x.route.includes('wait')).longPoll, true);
  assert.deepEqual(refusalCounts(http), { 'capability.unknown': 1, 'receipt.unknown': 1 });
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
});

test('cliCommand reads the eden.mjs command from a shell call', () => {
  assert.equal(cliCommand('node eden.mjs act walk:x --wait'), 'act');
  assert.equal(cliCommand('node eden.mjs Wren find "bench"'), 'find');
  assert.equal(cliCommand('cd /a && node ./eden.mjs look'), 'look');
  assert.equal(cliCommand('ls -la'), null);
});

test('seatStats counts only turns from the owner message on', () => {
  const turns = [{ turn: 1, startedAt: '2026-11-10T00:00:00Z', usage: { inputTokens: 5, cachedTokens: 100, cacheCreationTokens: 10, outputTokens: 20, costUsd: 0.01 } },
    { turn: 2, startedAt: '2026-11-10T00:01:00Z', usage: { inputTokens: 3, cachedTokens: 200, cacheCreationTokens: 0, outputTokens: 40, costUsd: 0.02 }, wallMs: 900 }];
  const tx = [{ turn: 1, type: 'assistant', message: { id: 'a', usage: {}, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node eden.mjs look' } }] } },
    { turn: 2, type: 'assistant', message: { id: 'b', usage: {}, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node eden.mjs find bench' } }] } },
    { turn: 2, type: 'assistant', message: { id: 'c', usage: {}, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node eden.mjs act sit:e_1 --wait' } }] } }];
  const s = seatStats(turns, tx, Date.parse('2026-11-10T00:00:30Z'));
  assert.equal(s.modelTurns, 1); assert.equal(s.apiCalls, 2); assert.equal(s.tokensIn, 203); assert.equal(s.tokensOut, 40); assert.equal(s.costUsd, 0.02);
  assert.deepEqual(s.cliCalls, { find: 1, act: 1 });
});

test('checks read the world, never the agent', () => {
  const pub = { self: { placePath: [{ id: 'g-eden-windmill' }, { id: 'world' }], bodyState: { posture: 'seated', activity: 'sit' } }, receipts: [] };
  const obs = observe(pub);
  assert.ok(judge({ placeKind: 'mill' }, { obs, catalog: cat }).ok);
  assert.ok(judge({ all: [{ placeKind: 'mill' }, { posture: 'seated' }] }, { obs, catalog: cat }).ok);
  assert.ok(!judge({ place: ['g-eden-bandstand'] }, { obs, catalog: cat }).ok);
  const bench = [{ id: 'r1', capability: 'sit:e_bench1', phase: 'started', chosen: { target: 'e_bench1' } }], chair = [{ id: 'r2', capability: 'sit:e_chair', phase: 'started' }];
  assert.ok(judge({ receipt: { verb: 'sit', thingKind: 'core-bench' } }, { obs, newReceipts: bench, catalog: cat }).ok);
  assert.ok(!judge({ receipt: { verb: 'sit', thingKind: 'core-bench' } }, { obs, newReceipts: chair, catalog: cat }).ok);
  assert.ok(!judge({ receipt: { verb: 'sit' } }, { obs, newReceipts: [{ capability: 'sit:e_1', phase: 'refused' }], catalog: cat }).ok);
  // a refusal item: an honest failure passes; a "done" with the body elsewhere does not
  const lake = { any: [{ card: 'failed' }, { place: ['g-land-west-lake-jetty'] }] };
  assert.ok(judge(lake, { obs, card: { state: 'acknowledged', outcome: 'failed', resultAt: 1 }, catalog: cat }).ok);
  assert.ok(!judge(lake, { obs, card: { state: 'acknowledged', outcome: 'done', resultAt: 1 }, catalog: cat }).ok);
});

test('the m4-v1 battery is valid, and fails fast on a world without its places', () => {
  const b = JSON.parse(readFileSync(new URL('./battery/m4-v1.json', import.meta.url)));
  assert.deepEqual(validateBattery(b), []);
  assert.deepEqual(validateBattery(b, cat), []);
  const errs = validateBattery(b, catalogIndex({ places: [{ id: 'field', kind: 'walkable' }], things: [] }));
  assert.ok(errs.some((e) => /g-eden-bandstand is not in this world/.test(e)));
  assert.ok(errs.some((e) => /no place of kind mill/.test(e)));
  assert.ok(validateBattery({ items: [{ id: 'x', instruction: 'a', check: { nope: 1 } }] }).some((e) => /unknown check/.test(e)));
});

test('summarize gives n/N and spread over repeats', () => {
  const ep = (item, ok, turns) => ({ item, succeeded: ok, seat: { modelTurns: turns, apiCalls: turns, tokensIn: 1, tokensOut: 1, costUsd: 0, cliCalls: { act: 1 } }, worldCalls: 2, firstMotionMs: 1000, successMs: 2000, clientMsPerCall: 5, serverMsPerCall: 3, refusals: { 'x.y': 1 } });
  const s = summarize([ep('a', true, 1), ep('a', false, 3), ep('b', true, 2)]);
  assert.equal(s.total.succeeded, 2); assert.equal(s.total.episodes, 3);
  const a = s.items.find((x) => x.item === 'a');
  assert.deepEqual(a.modelTurns, { median: 1, min: 1, max: 3, n: 2 });
  assert.deepEqual(a.refusals, { 'x.y': 2 });
});

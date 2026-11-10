// #1687: a live Claude seat starts from an allowlisted environment and fails a first-call context check. A fake `claude`
// on PATH stands in for the CLI: it writes the environment it saw and prints one stream-json call. No model is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as claude from './claude-headless.mjs';
import { childEnv } from '../../lib/proc.mjs';

test('seatEnv keeps only the allowlist, plus names given in PLAYTEST_SEAT_ENV_PASS', () => {
  const src = { HOME: '/h', PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDECODE: '1', CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_BASE_URL: 'http://proxy', EXTRA_ONE: 'a', EXTRA_TWO: 'b', PLAYTEST_SEAT_ENV_PASS: 'EXTRA_ONE, MISSING' };
  assert.deepEqual(claude.seatEnv(src), { HOME: '/h', PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', EXTRA_ONE: 'a' });
  assert.deepEqual(claude.seatEnv({ HOME: '/h' }), { HOME: '/h' });
});

test('childEnv merges the parent environment unless envExact', () => {
  const key = Object.keys(process.env)[0];
  assert.equal(childEnv({ A: '1' })[key], process.env[key]);
  assert.deepEqual(childEnv({ A: '1' }, true), { A: '1' });
});

test('seatCtxMax: 20000 by default, overridable, 0 turns it off', () => {
  assert.equal(claude.seatCtxMax({}), 20000);
  assert.equal(claude.seatCtxMax({ PLAYTEST_SEAT_CTX_MAX: '18000' }), 18000);
  assert.equal(claude.seatCtxMax({ PLAYTEST_SEAT_CTX_MAX: '0' }), 0);
  assert.equal(claude.seatCtxMax({ PLAYTEST_SEAT_CTX_MAX: 'x' }), 20000);
});

function fakeClaude(ctx) {
  const dir = mkdtempSync(join(tmpdir(), 'seat-env-1687-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(join(dir, 'env.json'))}, JSON.stringify(process.env));
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash'] });
out({ type: 'assistant', session_id: 's1', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 4, cache_read_input_tokens: ${ctx - 4}, cache_creation_input_tokens: 0, output_tokens: 3 } } });
setTimeout(() => { out({ type: 'result', subtype: 'success', result: 'hi', num_turns: 1, stop_reason: 'end_turn', session_id: 's1', total_cost_usd: 0.01, usage: {} }); }, 1500);
`);
  chmodSync(bin, 0o755);
  return dir;
}

async function withFake(ctx, extraEnv, fn) {
  const dir = fakeClaude(ctx), saved = { ...process.env };
  Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_BASE_URL: 'http://proxy.invalid', ...extraEnv });
  try { return await fn(dir); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
}

test('a seat turn sees only the allowlisted environment', async () => {
  await withFake(17000, {}, async (dir) => {
    const r = await claude.turn({ cwd: dir, sessionId: 's1', text: 'hello', maxWallSec: 20, resultGraceMs: 10 });
    const seen = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
    assert.equal(seen.CLAUDE_CODE_SIMPLE, undefined); assert.equal(seen.ANTHROPIC_BASE_URL, undefined);
    assert.equal(seen.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1'); assert.ok(seen.PATH.startsWith(dir));
    assert.deepEqual(r.seatCheck, { ok: true, firstCallTokens: 17000, max: 20000 });
    assert.equal(r.finalText, 'hi');
  });
});

test('a new session whose first call is past the limit is ended at once and marked failed', async () => {
  await withFake(31200, {}, async (dir) => {
    const t0 = Date.now();
    const r = await claude.turn({ cwd: dir, sessionId: 's1', text: 'hello', maxWallSec: 20, resultGraceMs: 10 });
    assert.deepEqual(r.seatCheck, { ok: false, firstCallTokens: 31200, max: 20000 });
    assert.ok(r.stream.some((e) => e.type === 'harness_seat_check' && e.ok === false));
    assert.ok(!r.stream.some((e) => e.type === 'result'), 'killed before the turn finished');
    assert.ok(Date.now() - t0 < 1500 + 1000);
  });
});

test('the check applies to a new session only, and 0 turns it off', async () => {
  await withFake(31200, {}, async (dir) => {
    const resumed = await claude.turn({ cwd: dir, sessionId: 's1', resume: true, text: 'again', maxWallSec: 20, resultGraceMs: 10 });
    assert.equal(resumed.seatCheck, null); assert.equal(resumed.finalText, 'hi');
    const off = await claude.turn({ cwd: dir, sessionId: 's1', text: 'hello', maxWallSec: 20, resultGraceMs: 10, ctxMax: 0 });
    assert.equal(off.seatCheck.ok, true);
  });
});

test('a seat that failed its first-call check takes no further live turn, and turns.jsonl records why', async () => {
  const { createSeat } = await import('../seat.mjs');
  const run = mkdtempSync(join(tmpdir(), 'seat-check-1687-'));
  try {
    const s = createSeat({ runDir: run, seat: { id: 'ada', adapter: 'claude-headless' }, worldBase: 'http://h', rails: {} });
    let n = 0;
    s.adapter = { turn: async (o) => { n++; return { stream: [], usage: null, finalText: null, toolCalls: [], exit: 143, wallMs: 1, sessionId: o.sessionId, seatCheck: { ok: false, firstCallTokens: 31200, max: 20000 } }; }, renderChat: () => '' };
    await s.chat('one'); const second = await s.chat('two');
    assert.equal(n, 1); assert.equal(second.refused, 'seat-check');
    const turns = readFileSync(join(run, 'seats', 'ada', 'turns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(turns.map((t) => t.seatCheck?.ok), [false, false]);
    assert.ok(readFileSync(join(run, 'seats', 'ada', 'turns.jsonl'), 'utf8').includes('"seatCheck":{"ok":false'), 'the string run-specs.sh greps for');
  } finally { rmSync(run, { recursive: true, force: true }); }
});

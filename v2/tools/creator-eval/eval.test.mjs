import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { externalAgent, measure, TASK } from './eval.mjs';

test('external driver publishes private paths, waits for completion, and retains its transcript for grading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'creator-driver-'));
  try {
    const pending = externalAgent(join(dir, 'agent'), dir, 1, { within: 1000, poll: 1 });
    const manifest = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8'));
    assert.equal(statSync(join(dir, 'ready.json')).mode & 0o777, 0o600);
    assert.equal(manifest.task, TASK);
    assert.equal(manifest.environment.SOULS_HOME, manifest.home);
    assert.ok(!JSON.stringify(manifest).includes('token'));
    const transcript = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'node souls-god.mjs check place fixture --in root' } }] } },
      { type: 'result', result: 'built', num_turns: 1 },
    ].map(JSON.stringify).join('\n');
    writeFileSync(manifest.transcript, transcript);
    writeFileSync(manifest.complete, 'done\n');
    assert.equal(await pending, transcript);
    assert.equal(measure(transcript).checks, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('external driver stops at its bounded wait without claiming a completed trial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'creator-driver-timeout-'));
  try {
    await assert.rejects(externalAgent(join(dir, 'agent'), dir, 2, { within: 5, poll: 1 }), /timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

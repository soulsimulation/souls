import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { construction, externalAgent, folder, measure, TASK } from './eval.mjs';

const scratch = fileURLToPath(new URL('../../../.local/g7b/adapter-tests/', import.meta.url));
mkdirSync(scratch, { recursive: true });

test('creator setup stays in the run scratch with only the skill, command and unpaired home', () => {
  const dir = mkdtempSync(join(scratch, 'setup-'));
  try {
    const f = folder(dir);
    assert.equal(f.at, join(dir, 'agent'));
    assert.equal(f.home, join(f.at, '.souls'));
    assert.deepEqual(readdirSync(f.at).sort(), ['.souls', 'creator.md', 'souls-god.mjs']);
    assert.deepEqual(readdirSync(f.home), ['kinds']);
    assert.equal(statSync(f.at).mode & 0o777, 0o700);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('external driver publishes private paths, waits for completion, and retains its transcript for grading', async () => {
  const dir = mkdtempSync(join(scratch, 'driver-'));
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
  const dir = mkdtempSync(join(scratch, 'driver-timeout-'));
  try {
    await assert.rejects(externalAgent(join(dir, 'agent'), dir, 2, { within: 5, poll: 1 }), /timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('construction reports plain and pinned rooms with their directly built contents', () => {
  const nodes = [
    { id: 'old', kind: 'eden:room', parent: null },
    { id: 'plain', kind: 'eden:room', parent: 'old' },
    { id: 'door', kind: 'core:door', parent: 'plain' },
    { id: 'chair', kind: 'core:chair', parent: 'plain' },
    { id: 'pinned', kind: 'eden:room@1220abcd', parent: 'old' },
    { id: 'seat', kind: 'core:chair@1220efab', parent: 'pinned' },
    { id: 'other', kind: 'eden:bedroom', parent: 'old' },
  ];
  const result = construction(nodes, new Set(['old']));
  assert.deepEqual(result.rooms, [
    { id: 'plain', holds: ['core:door', 'core:chair'] },
    { id: 'pinned', holds: ['core:chair@1220efab'] },
  ]);
  assert.deepEqual(result.added.find((n) => n.id === 'chair').in, ['eden:room', 'eden:room']);
  assert.equal(result.added.length, 6, 'the pre-existing room is not counted');
});

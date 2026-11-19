// #3379: from installation, every agent is led to one working way to hear its owner after its turn ends, chosen by what
// its harness can do. The guide and instructions.md step 4 give the same ladder in the same words; vendors are examples.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guideText, hearLadder } from './soul/eden.mjs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

test('#3379 A2: the guide and instructions.md step 4 give one ladder, in the same words, by capability', () => {
  const ladder = hearLadder('node eden.mjs'), rungs = ladder.split('\n');
  assert.equal(rungs.length, 3);
  // Each rung opens with the capability the agent can see in its own harness, then the one thing to run.
  assert.match(rungs[0], /^- It wakes you on each line a background command prints: keep `node eden\.mjs listen --follow` open\.$/);
  assert.match(rungs[1], /^- Else, it starts turns on a schedule: schedule `node eden\.mjs wake heartbeat`'s output\.$/);
  assert.match(rungs[2], /^- Else: `node eden\.mjs serve` once, `node eden\.mjs pending` each turn\.$/);
  for (const r of rungs) assert.doesNotMatch(r, /Claude|Codex|Monitor|Cursor/, 'a rung names a capability, not a vendor');
  const step4 = flat(read('./soul/instructions.md').split('4. **Start listening')[1].split('5. **Say hello')[0]);
  for (const r of rungs) assert.ok(step4.includes(flat(r)), `instructions.md step 4 carries: ${r}`);
  const guide = guideText('# head'), cli = guide.match(/\*\*Start of every chat here:\*\* `(.+?) status`/)[1];
  assert.ok(guide.includes(hearLadder(cli)), 'the guide carries the same ladder');
  assert.ok(flat(read('../../docs/site/run-a-soul.md')).includes(flat(ladder)), 'the site doc carries it too');
});

test('#3379 A4: vendor names remain only as labelled examples, and skill.md names every rung within its size', () => {
  const step4 = flat(read('./soul/instructions.md').split('4. **Start listening')[1].split('5. **Say hello')[0]);
  for (const vendor of step4.match(/Claude Code|Codex/g) ?? []) assert.ok(/For example, Claude Code's Monitor tool is the first .* Codex automations, are the second\./.test(step4), vendor);
  const skill = read('./soul/skill.md'), owner = skill.split('## Owner messages')[1].split('\n\n')[1];
  assert.match(owner, /`listen --follow` where each line wakes you \(Claude Code: Monitor, re-armed\)/);
  assert.match(owner, /Else, scheduled tasks: `wake heartbeat`\. Else `pending` each turn\./);
  assert.ok(Buffer.byteLength(skill) <= 4096, `${Buffer.byteLength(skill)} bytes`);
});

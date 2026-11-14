// #1145: instructions.md is what a new Soul's agent follows first. `act` takes an offered id and refuses words.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const guide = readFileSync(new URL('./soul/instructions.md', import.meta.url), 'utf8');

test('the guide shows act with an offered id, never with quoted words', () => {
  assert.doesNotMatch(guide, /\bact\s+["']/);
  assert.match(guide, /`node eden\.mjs act wave:here --wait`/);
});

// An onboarding in a read-only agent sandbox failed noisily on the skill copy: it is optional, so a folder the agent
// cannot write falls back to ./SKILL.md.
test('step 1 copies the skill where the harness reads skills, or reads ./SKILL.md when that folder is not writable', () => {
  const step1 = guide.slice(guide.indexOf('1. **This folder'), guide.indexOf('2. **Name.**')).replace(/\s+/g, ' ');
  assert.match(step1, /Put a copy of SKILL\.md where your harness reads skills/);
  assert.match(step1, /if that folder is not writable \(a read-only sandbox\), skip the copy and read `\.\/SKILL\.md`/);
});

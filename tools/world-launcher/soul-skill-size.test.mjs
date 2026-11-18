// CTRL-7 (#1099), moved from the server's publication test (#1935): the core skill every world serves stays short.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the core skill is at most 4,096 bytes', () => {
  const bytes = readFileSync(new URL('./soul/skill.md', import.meta.url)).length;
  assert.ok(bytes <= 4096, 'core skill ' + bytes);
});

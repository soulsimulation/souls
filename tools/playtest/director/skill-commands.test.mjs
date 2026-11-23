// 0.135 P2: the director skill names only commands the new client has. Every `eden.mjs <command>` (the file a world
// serves is the new client, v2/client/served/build.mjs) in the skill is one the thin command's head lists.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../../lib/paths.mjs';

const client = readFileSync(join(REPO_ROOT, 'v2/client/src/cli/souls.mjs'), 'utf8');
const has = new Set([...client.matchAll(/^\/\/\s+souls\.mjs ([a-z][a-z-]*)/gm)].map((m) => m[1]));

test('the director skill names only commands the new client has', () => {
  assert.ok(has.has('pair') && has.has('act') && has.has('listen'), `the client's commands: ${[...has].join(' ')}`);
  for (const f of ['SKILL.md', 'MEASURED.md']) {
    const text = readFileSync(join(REPO_ROOT, '.claude/skills/souls-director', f), 'utf8');
    const named = [...text.matchAll(/eden\.mjs ([a-z][a-z-]*)/g)].map((m) => m[1]);
    const missing = [...new Set(named.filter((c) => !has.has(c)))];
    assert.deepEqual(missing, [], `${f} names commands the new client lacks: ${missing.join(', ')}`);
  }
});

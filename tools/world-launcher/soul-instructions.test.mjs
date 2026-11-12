// #1145: instructions.md is what a new Soul's agent follows first. `act` takes an offered id and refuses words.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const guide = readFileSync(new URL('./soul/instructions.md', import.meta.url), 'utf8');

test('the guide shows act with an offered id, never with quoted words', () => {
  assert.doesNotMatch(guide, /\bact\s+["']/);
  assert.match(guide, /`node eden\.mjs act wave:here --wait`/);
});

// An onboarding in a read-only agent sandbox failed noisily on the skill copy: it is optional, so a folder it cannot write
// falls back to ./SKILL.md with one quiet line.
test('step 1 copies the skill where it can and otherwise says, in one line, that ./SKILL.md is used', (t) => {
  const copy = guide.split('\n').filter((l) => /^ {3}\{ mkdir -p \.claude\/skills|^ {5}\|\| echo/.test(l)).join('\n');
  assert.match(copy, /\|\| echo "note: /, 'the copy step and its fallback note');
  const run = (dir) => spawnSync('bash', ['-c', copy], { cwd: dir, encoding: 'utf8' });
  const home = () => {
    const d = mkdtempSync(join(tmpdir(), 'souls-instructions-'));
    t.after(() => { chmodSync(d, 0o755); rmSync(d, { recursive: true, force: true }); });
    writeFileSync(join(d, 'SKILL.md'), 'skill'); return d;
  };
  const writable = home(), ok = run(writable);
  assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, '', '']);
  assert.equal(readFileSync(join(writable, '.claude/skills/souls/SKILL.md'), 'utf8'), 'skill');
  const sandbox = home(); chmodSync(sandbox, 0o555);
  const ro = run(sandbox);
  assert.equal(ro.status, 0); assert.equal(ro.stderr, '');
  assert.match(ro.stdout, /^note: \.claude\/skills is not writable here; using \.\/SKILL\.md\n$/);
  assert.equal(existsSync(join(sandbox, '.claude')), false);
});

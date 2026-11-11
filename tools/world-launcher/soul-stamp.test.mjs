// #1935: the release owner stamps the client's version and hashes once per release, with one command, on a copy of the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const soul = fileURLToPath(new URL('./soul/', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('stamp.mjs refuses a stale or malformed version, stamps eden.mjs, the skill and every SOURCES.json entry, and --check agrees', (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'souls-stamp-')), 'soul'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(soul, dir, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [join(dir, 'stamp.mjs'), ...args], { encoding: 'utf8' });
  const read = (p) => readFileSync(join(dir, p), 'utf8'), before = JSON.parse(read('SOURCES.json'));
  const current = /^const VERSION = "([0-9.]+)";$/m.exec(read('eden.mjs'))[1], next = current.replace(/[0-9]+$/, (n) => String(Number(n) + 1));

  appendFileSync(join(dir, 'eden.mjs'), '// a client change\n'); appendFileSync(join(dir, 'skill.md'), 'A new line.\n');
  const stale = run('--check');
  assert.equal(stale.status, 1); assert.match(stale.stderr, /eden\.mjs does not hash/); assert.match(stale.stderr, /skill\.md does not hash/);
  for (const bad of [current, '0.1', '2.x', 'v9', '9.9.9-rc']) assert.equal(run(bad).status, 1, bad);
  assert.equal(read('eden.mjs').includes(`const VERSION = "${current}";`), true, 'a refused stamp writes nothing');

  assert.equal(run(next).status, 0);
  assert.match(read('eden.mjs'), new RegExp(`^const VERSION = "${next}";$`, 'm'));
  assert.match(read('skill.md'), new RegExp(`^  version: "${next}"$`, 'm')); assert.match(read('skill.md'), new RegExp(`^# Soul — skill ${next}$`, 'm'));
  const after = JSON.parse(read('SOURCES.json'));
  assert.deepEqual([after.controllerCli.version, after.skill.version], [next, next]);
  assert.deepEqual([after.cli.version, after.schemaNotes.version, after.instructions.version, after.runtime.version], [before.cli.version, before.schemaNotes.version, before.instructions.version, before.runtime.version], 'other lines keep their versions');
  for (const [k, file] of [['controllerCli', 'eden.mjs'], ['skill', 'skill.md'], ['cli', 'eden-agent.mjs'], ['schemaNotes', 'schema-notes.md'], ['instructions', 'instructions.md']]) assert.equal(after[k].sha256, sha(readFileSync(join(dir, file))), k);
  for (const a of after.runtime.artifacts) assert.equal(a.sha256, sha(readFileSync(join(dir, 'runtime', a.file))), a.file);
  assert.deepEqual(after.legacy, before.legacy, 'the 1.9 guide provenance is kept');
  assert.equal(run('--check').status, 0, 'stamped');
  assert.equal(run(next).status, 0, 'a re-stamp of unchanged bytes is a no-op');
});

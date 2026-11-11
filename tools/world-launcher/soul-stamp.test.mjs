// #1935: the release owner stamps the client's version and hashes once per release, with one command, on a copy of the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frozen, listed } from './soul/stamp.mjs';

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

// #2000: a stamp re-hashes only eden.mjs and skill.md. Every other file SOURCES.json lists keeps its own version, so an edit to
// one fails here, in PR CI, until its version and sha256 move in the same pull request; and a stamp refuses to re-hash it.
test('the frozen client files (eden-agent.mjs, instructions.md, schema-notes.md, the runtime) match their SOURCES.json pins', () => {
  const off = frozen((p) => { try { return readFileSync(join(soul, p)); } catch { return null; } });
  assert.deepEqual(off, [], off.join('\n'));
});

test('a frozen file whose sha256 changed since the latest release tag also changed its version', (t) => {
  const git = (...args) => { try { return execFileSync('git', ['-C', soul, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const tag = git('describe', '--tags', '--match', 'v*', '--abbrev=0');
  if (!tag) return t.skip('no release tag (v*) is reachable from HEAD; fetch tags (CI checks out with fetch-depth 0) to compare frozen versions');
  const then = JSON.parse(git('show', `${tag}:./SOURCES.json`)), now = JSON.parse(readFileSync(join(soul, 'SOURCES.json'), 'utf8'));
  const versioned = (s) => new Map(listed(s).filter(([p]) => p !== s.controllerCli.file && p !== s.skill.file)
    .map(([p, e]) => [p, { sha256: e.sha256, version: s.runtime?.artifacts?.includes(e) ? s.runtime.version : e.version }]));
  const before = versioned(then), off = [];
  for (const [p, e] of versioned(now)) {
    const b = before.get(p);
    if (b && b.sha256 !== e.sha256 && b.version === e.version) off.push(`${p} changed since ${tag} but its SOURCES.json version is still ${e.version}: move the version with the sha256`);
  }
  assert.deepEqual(off, [], off.join('\n'));
});

test('an edit to a frozen file is named, and stamp.mjs refuses to re-hash it under an unchanged version', (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'souls-stamp-')), 'soul'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(soul, dir, { recursive: true });
  const read = (p) => { try { return readFileSync(join(dir, p)); } catch { return null; } };
  const runtime = JSON.parse(read('SOURCES.json')).runtime, edited = ['eden-agent.mjs', 'instructions.md', `${runtime.directory}/${runtime.artifacts[0].file}`];
  for (const f of edited) appendFileSync(join(dir, f), '\n');
  appendFileSync(join(dir, 'eden.mjs'), '// a client change\n');
  const off = frozen(read);
  assert.equal(off.length, edited.length, off.join('\n'));
  for (const f of edited) assert.ok(off.some((l) => l.startsWith(`${f} is frozen and changed: move its version and sha256`)), f);
  const before = read('SOURCES.json').toString('utf8');
  const r = spawnSync(process.execPath, [join(dir, 'stamp.mjs'), '99.0.0'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /instructions\.md is frozen and changed/);
  assert.equal(read('SOURCES.json').toString('utf8'), before, 'a refused stamp writes nothing');
  assert.equal(read('eden.mjs').toString('utf8').includes('const VERSION = "99.0.0";'), false);
});

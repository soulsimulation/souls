// #1098 arm B2: a live seat never runs inside a repository checkout, and runs default to a folder outside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAncestor, assertSeatHome } from './seat-home.mjs';
import { Seat } from './seat.mjs';
import { defaultRunsDir } from '../runs/lifecycle.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';

test('a folder inside a checkout (or under a CLAUDE.md or AGENTS.md) names that project; a plain folder names none', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-home-'));
  const repo = join(root, 'repo'), seat = join(repo, '.local', 'runs', 'r1', 'playtest', 'seats', 'bo', 'folder');
  mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(seat, { recursive: true });
  assert.deepEqual(projectAncestor(seat, { home: root }), { dir: repo, marker: '.git' });
  const plain = join(root, 'runs', 'r1', 'seats', 'bo', 'folder'); mkdirSync(plain, { recursive: true });
  assert.equal(projectAncestor(plain, { home: join(root, 'nobody') }), null);
  const notes = join(root, 'notes', 'seats', 'bo', 'folder'); mkdirSync(notes, { recursive: true }); writeFileSync(join(root, 'notes', 'AGENTS.md'), '# rules\n');
  assert.equal(projectAncestor(notes, { home: root }).marker, 'AGENTS.md');
  // the user's own ~/.claude is the login's user config (the seat already excludes user settings and CLAUDE.md): not a project
  mkdirSync(join(root, 'home', '.claude'), { recursive: true }); const athome = join(root, 'home', 'runs', 'seats', 'bo', 'folder'); mkdirSync(athome, { recursive: true });
  assert.equal(projectAncestor(athome, { home: join(root, 'home') }), null);
  assert.throws(() => assertSeatHome(seat, { home: root }), /seat\.home-in-project: .* \(it has \.git\)/);
  assert.doesNotThrow(() => assertSeatHome(plain, { home: join(root, 'nobody') }));
});

test('a live seat is refused inside this checkout; a scripted seat is not', () => {
  const inRepo = join(REPO_ROOT, '.local', 'seat-home-test', 'bo');
  assert.throws(() => new Seat({ dir: inRepo, seat: { id: 'bo', adapter: 'claude-headless' }, worldBase: 'http://127.0.0.1:1/w/x' }), /seat\.home-in-project/);
  assert.doesNotThrow(() => new Seat({ dir: inRepo, seat: { id: 'bo', adapter: 'scripted-owner' }, worldBase: 'http://127.0.0.1:1/w/x' }));
});

test('runs default outside every checkout; SOULS_RUNS_DIR and SIM_SCRATCH still decide when set', () => {
  const d = defaultRunsDir({});
  assert.equal(projectAncestor(d), null, d);
  assert.ok(!d.startsWith(REPO_ROOT + '/'), d);
  assert.equal(defaultRunsDir({ SOULS_RUNS_DIR: '/tmp/x-runs' }), '/tmp/x-runs');
  assert.match(defaultRunsDir({ SIM_SCRATCH: '/tmp/x-scratch' }), /\/tmp\/x-scratch\/soul-runs$/);
});

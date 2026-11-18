// release-pin.mjs: a release of a pinned sha while main keeps moving (release.yml -f sha), and gate.yml's default
// baseline, the last release tag reachable from the candidate. Real git in a temporary repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { lastRelease, PIN_AWARE, pinProblem } from './deploy/ship/release-pin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '../..'), PIN = join(HERE, 'deploy/ship/release-pin.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' } }).trim();

// main: c1 (v0.129, and a stray v4.18) - c2 (v0.130) - c3 - c4 (adds release-pin.mjs) - c5 = origin/main; c6 local only
function repo() {
  const t = mkdtempSync(join(tmpdir(), 'release-pin-')), r = join(t, 'repo');
  execFileSync('git', ['init', '-q', '--bare', join(t, 'origin.git')]);
  execFileSync('git', ['init', '-q', r]); git(r, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const c = [];
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(r, 'f'), String(i)); git(r, 'add', 'f');
    if (i === 4) { mkdirSync(dirname(join(r, PIN_AWARE)), { recursive: true }); writeFileSync(join(r, PIN_AWARE), ''); git(r, 'add', PIN_AWARE); }
    git(r, 'commit', '-qm', `c${i}`); c[i] = git(r, 'rev-parse', 'HEAD');
  }
  git(r, 'tag', '-a', 'v0.129', c[1], '-m', 'r'); git(r, 'tag', '-a', 'v4.18', c[1], '-m', 'stray'); git(r, 'tag', '-a', 'v0.130', c[2], '-m', 'r');
  git(r, 'remote', 'add', 'origin', join(t, 'origin.git')); git(r, 'push', '-q', 'origin', 'main'); git(r, 'fetch', '-q', 'origin');
  writeFileSync(join(r, 'f'), '6'); git(r, 'commit', '-qam', 'c6'); c[6] = git(r, 'rev-parse', 'HEAD');
  return { r, c };
}

test('the baseline is the last v0.* release reachable from the candidate, never the version sort (v4.18)', () => {
  const { r, c } = repo();
  assert.equal(git(r, 'tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0], 'v4.18', 'the old default picked the stray tag');
  assert.equal(lastRelease(c[5], r), 'v0.130');
  assert.equal(lastRelease(c[4], r), 'v0.130', 'a pinned candidate behind main');
  assert.equal(lastRelease(c[1], r), 'v0.129', 'a candidate before the last release compares with its own');
  const cli = spawnSync(process.execPath, [PIN, 'last', c[4]], { cwd: r, encoding: 'utf8' });
  assert.deepEqual([cli.status, cli.stdout.trim()], [0, 'v0.130']);
});

test('a pinned sha must be a full commit on origin/main and newer than the last release', () => {
  const { r, c } = repo(), problem = (sha) => pinProblem(sha, { cwd: r });
  assert.equal(problem(c[4]), null, 'one behind main');
  assert.equal(problem(c[5]), null, 'main itself');
  assert.match(problem(c[3]), /predates pinned-sha releases/, 'its own eyes.mjs would refuse a run at main\'s head');
  assert.match(problem(c[4].slice(0, 12)), /full 40-hex/);
  assert.match(problem(''), /full 40-hex/);
  assert.match(problem('f'.repeat(40)), /not a commit/);
  assert.match(problem(c[6]), /not an ancestor of origin\/main/);
  assert.match(problem(c[2]), /is the last release v0\.130 itself/);
  assert.match(problem(c[1]), /not newer than the last release v0\.130/);
  let cli = spawnSync(process.execPath, [PIN, 'check', c[4]], { cwd: r, encoding: 'utf8' });
  assert.deepEqual([cli.status, cli.stdout.trim()], [0, 'last=v0.130']);
  cli = spawnSync(process.execPath, [PIN, 'check', c[1], '--main', 'origin/main'], { cwd: r, encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.match(cli.stderr, /not newer than the last release/);
});

test('the workflows: release.yml takes sha into every job through preflight, and gate.yml defaults its baseline to it', () => {
  const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8'), gate = readFileSync(join(ROOT, '.github/workflows/gate.yml'), 'utf8');
  assert.match(release, /^ {6}sha:\n {8}description: Pinned release head/m);
  assert.match(release, /release-pin\.mjs check "\$PIN" --main origin\/main/);
  assert.match(release, /git checkout -q --detach "\$PIN"/);
  assert.match(release, /if \[ -z "\$PIN" \] && \[ -n "\$FROZEN" \]/, 'the freeze is not consulted for a pinned sha');
  assert.match(release, /^run-name: release \$\{\{ inputs\.version \}\}\$\{\{ inputs\.sha && format\(' at \{0\}', inputs\.sha\) \|\| '' \}\}$/m);
  // every job after preflight reads its sha output, never main's HEAD
  for (const job of ['receipts', 'ship', 'eyes', 'publish']) {
    const body = release.split(new RegExp(`^  ${job}:\\n`, 'm'))[1].split(/^ {2}[a-z]+:\n/m)[0];
    assert.match(body, /needs\.preflight\.outputs\.sha/, job);
    assert.doesNotMatch(body, /rev-parse HEAD/, job);
  }
  assert.match(gate, /baseline=\$\(node tools\/world-launcher\/deploy\/ship\/release-pin\.mjs last "\$sha"/);
  assert.doesNotMatch(gate, /--sort=-v:refname/);
  assert.match(gate, /baseline="\$BASELINE_IN"/, 'an explicit -f baseline= still wins');
});

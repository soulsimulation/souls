// The walk audit's scratch world copy (walk-audit-* in the temp dir) is removed when the audit exits: after a finished
// run, a failed one and a killed one (SIGINT, SIGTERM, SIGKILL: its detached watcher removes it), and kept only on
// --keep. Each case runs one audit on a tiny genesis (hello-hamlet, about 2 s) with TMPDIR pointed at this test's own
// empty directory, so it counts only that run's folders and never touches anyone else's.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT, ROOT } from './walk.mjs';

const base = mkdtempSync(join(tmpdir(), 'walk-scratch-test-'));
after(() => rmSync(base, { recursive: true, force: true }));
const GENESIS = 'worlds/templates/hello-hamlet.json';

function audit(args, { onScratch } = {}) {
  const tmp = mkdtempSync(join(base, 'tmp-')), scratch = () => readdirSync(tmp).filter(f => f.startsWith('walk-audit-'));
  const env = { ...process.env, TMPDIR: tmp }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [join(ROOT, AUDIT), ...args], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-2000); });
  let seen = false;
  const poll = onScratch && setInterval(() => { if (!seen && scratch().length) { seen = true; onScratch(child); } }, 20);
  return new Promise(done => child.on('close', async (code, signal) => {
    if (poll) clearInterval(poll);
    // a killed audit's copy goes within about a second of its exit (the watcher polls every 0.5 s)
    for (let i = 0; i < 50 && scratch().length && signal; i++) await new Promise(r => setTimeout(r, 100));
    done({ code, signal, err, seen, left: scratch() });
  }));
}

test('a finished audit removes its scratch copy', { timeout: 240_000 }, async () => {
  const r = await audit(['--genesis', GENESIS, '--out', join(base, 'part.json')]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.left, []);
});

test('a failed audit (unreadable world copy) removes its scratch copy', { timeout: 60_000 }, async () => {
  const r = await audit(['--db', join(base, 'missing.db')]);
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.left, []);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
  test(`an audit killed by ${sig} removes its scratch copy`, { timeout: 240_000 }, async () => {
    const r = await audit(['--genesis', GENESIS, '--out', join(base, `part-${sig}.json`)], { onScratch: c => c.kill(sig) });
    assert.ok(r.seen, 'the scratch folder appeared before the signal');
    assert.equal(r.signal, sig, r.err);
    assert.deepEqual(r.left, []);
  });
}

test('--keep keeps the scratch copy', { timeout: 240_000 }, async () => {
  const r = await audit(['--genesis', GENESIS, '--keep', '--out', join(base, 'part-keep.json')]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.left.length, 1);
});

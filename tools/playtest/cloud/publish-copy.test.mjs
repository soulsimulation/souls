// #1311: publishing scrubs and guards a copy, and a finished run keeps its world data and seat folders. The real scripts, on planted files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationFindings } from '../../proof/publication.mjs';

const script = fileURLToPath(new URL('./publish-copy.sh', import.meta.url));
const publish = (out, dest, ...a) => spawnSync('bash', [script, out, dest, ...a], { encoding: 'utf8' });
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const snapshot = (d) => Object.fromEntries(walk(d).map((f) => [relative(d, f), createHash('sha256').update(readFileSync(f)).digest('hex')]));

function finishedRun(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publish-copy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'results', 'arm-1'), run = join(out, 's3-steer-r1', 'playtest');
  mkdirSync(join(run, 'seats', 'ada', 'folder'), { recursive: true }); mkdirSync(join(run, 'server', 'data'), { recursive: true });
  writeFileSync(join(run, 'seats', 'ada', 'folder', '.eden-agent.json'), '{"token":"planted"}');
  writeFileSync(join(run, 'server', 'data', 'sim.db'), Buffer.from([0x53, 0x51, 0, 0, 1, 2, 3]));
  writeFileSync(join(run, 'seats', 'ada', 'transcript.jsonl'), `${JSON.stringify({ cmd: `cat ${homedir()}/notes; curl http://127.0.0.1:4452/w/x`, ...extra })}\n`);
  writeFileSync(join(out, 'arm.log'), 'arm start\n'); writeFileSync(join(out, '.cloud-times'), 'run 1 0\n');
  return { root, out, dest: join(root, 'branch', 'results', 'arm-1') };
}

test('the run keeps its world data and seat folders; the published copy is scrubbed and passes the check', (t) => {
  const { out, dest } = finishedRun(t), before = snapshot(out);
  const r = publish(out, dest, '--scrub'); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(out), before, 'the run\'s own folder is byte for byte as it was');
  assert.ok(existsSync(join(out, 's3-steer-r1', 'playtest', 'server', 'data', 'sim.db')) && existsSync(join(out, 's3-steer-r1', 'playtest', 'seats', 'ada', 'folder', '.eden-agent.json')));
  assert.ok(!existsSync(join(dest, 's3-steer-r1', 'playtest', 'server', 'data', 'sim.db')), 'world data is not published');
  assert.deepEqual(walk(dest).filter((f) => f.includes('/folder/')), [], 'no file of a seat folder is published (git keeps no empty folder)');
  assert.ok(!existsSync(join(dest, '.cloud-times')));
  for (const f of walk(dest)) assert.deepEqual(publicationFindings([relative(dest, f), readFileSync(f, 'utf8')]), [], relative(dest, f));
  assert.match(readFileSync(join(dest, 'OMITTED-PRIVATE.txt'), 'utf8'), /seat folder or world data/);
});

test('a token in the copy stops the commit (exit 3), names only the file, and leaves no copy; the run is untouched', (t) => {
  const { out, dest } = finishedRun(t, { note: `sim_s_ada_${'Zx9-_q'.repeat(6)}` }), before = snapshot(out);
  const r = publish(out, dest, '--scrub');
  assert.equal(r.status, 3, r.stderr); assert.match(r.stdout, /s3-steer-r1\/playtest\/seats\/ada\/transcript\.jsonl/); assert.ok(!r.stdout.includes('sim_s_ada'), 'never the value');
  assert.ok(!existsSync(dest), 'nothing left to commit'); assert.deepEqual(snapshot(out), before);
});

test('without --scrub only the guard runs, still on the copy; a bad destination is refused', (t) => {
  const { out, dest } = finishedRun(t), before = snapshot(out);
  assert.equal(publish(out, dest).status, 0);
  assert.ok(existsSync(join(dest, 's3-steer-r1', 'playtest', 'server', 'data', 'sim.db')), 'other modes publish as before');
  assert.deepEqual(snapshot(out), before);
  assert.equal(publish(out, out, '--scrub').status, 2, 'never the run\'s own folder'); assert.deepEqual(snapshot(out), before);
  assert.equal(publish(out, '').status, 2);
  assert.ok(statSync(out).isDirectory());
});

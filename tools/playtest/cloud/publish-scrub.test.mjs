// #1131: a spec arm's results reach a public branch only through this. The real script as a child process, on planted files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./publish-scrub.mjs', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' });

test('machine details are replaced, what can\'t pass the check goes, and only its name is listed', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'publish-scrub-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, 'run/seats/ada/folder'), { recursive: true });
  writeFileSync(join(d, 'run/seats/ada/folder/.eden-agent.json'), '{"token":"planted"}');
  writeFileSync(join(d, 'run/shot.png'), Buffer.from([0x89, 0x50, 0, 0, 1]));
  writeFileSync(join(d, 'run/transcript.jsonl'), `${JSON.stringify({ cmd: `curl http://127.0.0.1:4452/w/x; cat ${homedir()}/a; ls /tmp/x-1/b; plugin@builtin` })}\n`);
  writeFileSync(join(d, 'run/lan.md'), 'the box at 192.168.1.20 answered\n');
  const r = run(d); assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(d, 'run/transcript.jsonl'), 'utf8');
  for (const leak of ['127.0.0.1', homedir(), '/tmp/x-1', 'plugin@builtin']) assert.ok(!text.includes(leak), leak);
  assert.ok(!existsSync(join(d, 'run/seats/ada/folder/.eden-agent.json')), 'seat folders go');
  assert.ok(!existsSync(join(d, 'run/shot.png')), 'binaries go');
  assert.ok(!existsSync(join(d, 'run/lan.md')), 'a file that still fails the check goes');
  const listed = readFileSync(join(d, 'OMITTED-PRIVATE.txt'), 'utf8');
  assert.match(listed, /run\/lan\.md: private network address/); assert.ok(!listed.includes('192.168.1.20'), 'the value is never listed');
});

test('a run it can\'t read exits non-zero, so nothing is published', () => {
  assert.notEqual(run().status, 0);
  assert.notEqual(run(join(tmpdir(), 'publish-scrub-no-such-folder')).status, 0);
});

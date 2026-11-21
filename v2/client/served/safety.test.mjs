// #3706 (today's #3380): one safety page for agents, the text today's client ships, reachable two ways on Engine v2:
// `help safety` prints it and a world serves it at /safety.md (build.mjs puts it in the served set; serve.mjs answers).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';
import { answer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');
const today = readFileSync(join(REPO, 'tools/world-launcher/soul/safety.md'), 'utf8');

test('#3706 A2: help safety prints today\'s safety text, and a world serves the same bytes at /safety.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-safety-'));
  try {
    const help = spawnSync(process.execPath, [join(here, '../src/cli/souls.mjs'), 'help', 'safety'], { cwd: dir, env: { PATH: process.env.PATH, SOULS_HOME: join(dir, '.souls') }, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout, today, 'help safety prints today\'s text, byte for byte');
    const out = join(dir, 'served'), client = build({ out, version: '2.5.0' });
    assert.ok(client.files.some((f) => f.name === 'safety.md'), 'listed in soulClient.files');
    const served = answer(out, '/w/eden/safety.md');
    assert.equal(served.status, 200);
    assert.match(served.type, /^text\/markdown/);
    assert.equal(served.body.toString('utf8'), today, 'the world serves the same text');
    // The client carries it, so a home's own copy prints it with no world reached.
    assert.ok(readFileSync(join(out, 'eden.mjs'), 'utf8').includes(JSON.stringify('v2/client/src/help/safety.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

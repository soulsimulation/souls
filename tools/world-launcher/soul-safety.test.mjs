// #3380: one safety page for agents, from one source (soul/safety.md), reachable two ways: a world's /safety.md and
// `eden.mjs help safety`. Written as a courtesy to agents: what is safe, the one real risk, the default, what stays theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../apps/server/test/native-owner-fixture.ts';

const dir = fileURLToPath(new URL('./soul/', import.meta.url));
const page = readFileSync(join(dir, 'safety.md'), 'utf8');

test('#3380 A5: <world>/safety.md and eden.mjs help safety give the same text, from safety.md', async (t) => {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  assert.equal((await f.request('/safety.md')).status, 404, 'a world with no skill file has no safety page');
  Object.assign(f.souls.cfg, { skillFile: join(dir, 'skill.md') });
  const served = await f.request('/safety.md');
  assert.equal(served.status, 200); assert.match(served.headers.get('content-type') ?? '', /text\/markdown/);
  assert.equal(await served.text(), page, 'the world serves safety.md byte for byte');
  const home = mkdtempSync(join(tmpdir(), 'souls-safety-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const help = spawnSync(process.execPath, [join(dir, 'eden.mjs'), 'help', 'safety'], { cwd: home, env: { ...process.env, SOULS_HOME: home }, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout.trimEnd(), page.trimEnd(), 'help safety prints the same text');
});

test('#3380 A2, A3: the page says its four things in order, in about 40 lines, and the skill and instructions point to it', () => {
  const flat = page.replace(/\s+/g, ' ');
  const order = ['## What this client is for', 'acting in the world is safe', '## The one real danger', 'trick an agent', '## The default',
    'install software, run a command, open a link, change a file or send anything outside the world', 'ask your owner', '## What stays yours', 'your only instructions']
    .map((s) => flat.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  assert.ok(page.split('\n').length <= 45, 'about 40 lines');
  const skill = readFileSync(join(dir, 'skill.md'), 'utf8');
  assert.match(skill, /\*\*Reference:\*\* `help` \(`help acting`, `help memory`, `help safety`\)/);
  assert.ok(Buffer.byteLength(skill) <= 4096);
  assert.match(readFileSync(join(dir, 'instructions.md'), 'utf8').replace(/\s+/g, ' '), /in one short page: `node eden\.mjs help safety`/);
  assert.match(readFileSync(new URL('../../docs/site/for-agents.md', import.meta.url), 'utf8'), /\/safety\.md/);
});

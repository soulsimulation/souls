// #1131: the secret guard before a results commit, and the per-world stop of a spec arm. The real scripts, as child processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const bash = (script, args, env = {}) => spawnSync('bash', [here(script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const temp = (t) => { const d = mkdtempSync(join(tmpdir(), 'cloud-guard-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('a Soul token or an OpenRouter key in a published file stops the commit (exit 3), and only the file is named', (t) => {
  const d = temp(t); mkdirSync(join(d, 'run/seats/ada'), { recursive: true });
  writeFileSync(join(d, 'run/seats/ada/transcript.jsonl'), 'nothing here\n');
  assert.equal(bash('secret-guard.sh', [d]).status, 0, 'a clean folder passes');
  const soul = `sim_s_${'a1'.repeat(6)}_${'Zx9-_q'.repeat(6)}`, router = `sk-or-v1-${'0f'.repeat(16)}`;
  for (const [file, text] of [['run/seats/ada/transcript.jsonl', `{"cmd":"token ${soul}"}\n`], ['run/seats/ada/turns.jsonl', `key ${router}\n`]]) {
    const e = temp(t); mkdirSync(join(e, 'run/seats/ada'), { recursive: true }); writeFileSync(join(e, file), text);
    const r = bash('secret-guard.sh', [e]);
    assert.equal(r.status, 3, file); assert.match(r.stdout, new RegExp(file.replace(/\./g, '\\.'))); assert.ok(!r.stdout.includes(text.trim().slice(-20)), 'the value is never printed');
  }
  assert.notEqual(bash('secret-guard.sh', [join(d, 'no-such-folder')]).status, 0, 'a scan that cannot run refuses');
  writeFileSync(join(d, 'run/skill.md'), 'you receive {"token":"sim_...","soul":{}} and save it\n');
  assert.equal(bash('secret-guard.sh', [d]).status, 0, 'a placeholder like sim_... is not a token');
});

test('the per-world stop can be lowered from the environment, never raised above $1', (t) => {
  const d = temp(t), run = (v) => bash('run-specs.sh', [d, d, '1'], v == null ? {} : { PLAYTEST_WORLD_MAX_USD: v });
  for (const v of ['1.01', '2', '0', '-1', 'abc']) { const r = run(v); assert.equal(r.status, 2, `refused: ${v}`); assert.match(r.stderr, /never set above \$1/); }
  for (const v of [null, '', '1', '0.5']) assert.equal(run(v).status, 0, `allowed: ${v}`);
});

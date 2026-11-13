// #2257: a new user's agent finds login, adopt and the dashboard from the served first-run files alone. The plain asks map to
// commands in instructions.md, skill.md spends one line on them and stays within its size, `help` carries the detail, and
// the dashboard page says how long ago it last read /data.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE } from './soul/dashboard.mjs';

const read = (f) => readFileSync(new URL(`./soul/${f}`, import.meta.url), 'utf8');
const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

test('instructions.md maps the plain asks to login, adopt and dashboard', () => {
  const guide = read('instructions.md'), later = guide.slice(guide.indexOf('**Later, in plain words.**'));
  assert.ok(later.length < 900, 'a few lines');
  assert.match(later, /"Connect my account": `node eden\.mjs login https:\/\/sim\.eden\.art\/worlds\/w\/eden-2026 --for GL7R-YZYJ`/);
  assert.match(later, /`node eden\.mjs login wait`/);
  assert.match(later, /"Move my Soul to this computer": .*`node eden\.mjs adopt <name>`/);
  assert.match(later, /"Open my Soul's dashboard": `node eden\.mjs dashboard`[^]*give them the `dashboard`\s+URL/);
  assert.match(later, /help account`, `node eden\.mjs help dashboard`/);
});

test('skill.md spends one line on them and stays within 4,096 bytes', () => {
  const skill = read('skill.md'), lines = skill.split('\n').filter((l) => /`login`|`dashboard`/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"Connect my account": `login`; "move my Soul here": `adopt <name>` \(`help account`\); "open my dashboard": `dashboard`, give its URL\./);
  assert.ok(Buffer.byteLength(skill) <= 4096, 'skill ' + Buffer.byteLength(skill));
});

test('help account and help dashboard name the plain asks, one screen each', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soul-onboard-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const help = (topic) => execFileSync(process.execPath, [cli, 'help', topic], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: dir } });
  const account = help('account'), dashboard = help('dashboard');
  assert.match(account, /"connect my account": steps 1 and 2\. "Move my Soul to this computer": steps 3 and 4\./);
  assert.match(dashboard, /"open my Soul's dashboard": step 1\./);
  assert.match(dashboard, /run it in your\s+harness's background process/);
  for (const out of [account, dashboard]) assert.ok(out.trimEnd().split('\n').length <= 24, 'one screen');
});

test('the dashboard page re-renders from /data.json in place and says how long ago', () => {
  assert.match(PAGE, /fetch\("\/data\.json", \{ cache: "no-store" \}\)\.then\(function \(r\) \{ return r\.json\(\); \}\)\.then\(render\)/);
  assert.match(PAGE, /setInterval\(tick, 5000\); setInterval\(ago, 1000\);/);
  assert.match(PAGE, /<p id="ago"/);
  assert.match(PAGE, /"updated " \+ Math\.round\(\(Date\.now\(\) - read\) \/ 1000\) \+ " s ago"/);
  assert.ok(!/location\.reload|http-equiv="refresh"/.test(PAGE), 'no page reload');
});

// deploy/eyes-browser.mjs --install (#1340): with a stand-in Playwright (EDGE_EYES_PLAYWRIGHT) whose CLI "installs" by
// creating the expected executable. Nothing is downloaded and no real browser folder is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'deploy/eyes-browser.mjs');

function setup({ installFails = false } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'eyes-browser-')), browsers = join(t, 'browsers'), pkg = join(t, 'viewer');
  const pw = join(pkg, 'node_modules/@playwright/test'); mkdirSync(pw, { recursive: true }); mkdirSync(browsers);
  writeFileSync(join(pkg, 'package.json'), '{"name":"viewer"}');
  writeFileSync(join(pw, 'package.json'), '{"name":"@playwright/test","main":"index.js"}');
  writeFileSync(join(pw, 'index.js'), `const p = require('path'); module.exports = { chromium: { executablePath: () => p.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1248/chrome-linux64/chrome') } };`);
  writeFileSync(join(pw, 'cli.js'), `const fs = require('fs'), p = require('path');
fs.appendFileSync(${JSON.stringify(join(t, 'cli.log'))}, process.argv.slice(2).join(' ') + ' gc=' + process.env.PLAYWRIGHT_SKIP_BROWSER_GC + '\\n');
${installFails ? 'process.exit(1);' : ''}
const exe = p.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1248/chrome-linux64/chrome'); fs.mkdirSync(p.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');`);
  const run = (...args) => { const r = spawnSync(process.execPath, [TOOL, '--browsers', browsers, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, EDGE_EYES_PLAYWRIGHT: join(pkg, 'package.json') } });
    return { code: r.status, json: JSON.parse(r.stdout.trim().split('\n').at(-1)), out: r.stdout + r.stderr }; };
  const calls = () => (existsSync(join(t, 'cli.log')) ? readFileSync(join(t, 'cli.log'), 'utf8') : '');
  return { t, browsers, run, calls };
}

test('without --install a missing revision is reported, exit 1, and nothing is installed', () => {
  const s = setup(), r = s.run();
  assert.equal(r.code, 1, r.out); assert.equal(r.json.revision, '1248'); assert.match(r.json.problem, /^no-browser: expected chromium-1248$/); assert.match(r.json.log, /install it: PLAYWRIGHT_BROWSERS_PATH=/);
  assert.equal(s.calls(), '');
});

test('--install installs exactly the expected revision with the release\'s own CLI, never collecting other browsers, then checks it', () => {
  const s = setup(); mkdirSync(join(s.browsers, 'chromium-1194/chrome-linux64'), { recursive: true }); writeFileSync(join(s.browsers, 'chromium-1194/chrome-linux64/chrome'), '');
  const r = s.run('--install');
  assert.equal(r.code, 0, r.out); assert.equal(r.json.source, 'playwright'); assert.equal(r.json.installed, 'chromium-1248');
  assert.equal(s.calls(), 'install chromium gc=1\n');
  assert.ok(existsSync(join(s.browsers, 'chromium-1194/chrome-linux64/chrome')), 'the older revision stays');
  // idempotent: a second run finds it and installs nothing
  const again = s.run('--install');
  assert.equal(again.code, 0); assert.equal(again.json.installed, undefined); assert.equal(s.calls(), 'install chromium gc=1\n');
});

test('a failed install never stops a release: exit 0, a WARN edenEyes: degraded line and the degraded marker', () => {
  const s = setup({ installFails: true }); mkdirSync(join(s.browsers, 'chromium-1194/chrome-linux64'), { recursive: true }); writeFileSync(join(s.browsers, 'chromium-1194/chrome-linux64/chrome'), '');
  const r = s.run('--install');
  assert.equal(r.code, 0, r.out);
  assert.match(r.json.degraded, /installing chromium-1248 did not give Playwright its own Chromium .*failed .*exit 1/); assert.equal(r.json.problem, undefined); assert.equal(r.json.path, null);
  assert.match(r.out, /^WARN edenEyes: degraded \([^()\n/]+\)$/m, 'one path-free line ship.sh can carry into ship-result.json');
});

test('--warn checks only: a missing browser is WARN edenEyes: degraded and exit 0, and nothing is installed', () => {
  const s = setup(), r = s.run('--warn');
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^WARN edenEyes: degraded \(no-browser: expected chromium-1248\)$/m);
  assert.equal(s.calls(), '');
});

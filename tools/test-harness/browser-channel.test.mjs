// Browser scripts launch Playwright's own Chromium (`channel: 'chromium'`), never the installed Google Chrome: a run
// that hangs on real Chrome leaves a headless copy of Chrome.app alive, and macOS then shows the user's own Chrome as
// open with no window. docs/testing.md#browser-channel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'tools/test-harness/browser-channel.test.mjs';
// Files allowed to reach real Chrome, each with its reason.
const ALLOW = new Map([
  ['tools/world-launcher/soul/eden.mjs', 'tries chromium first; Chrome is the last fallback on hosts without it'],
  ['tools/world-launcher/soul/render.mjs', 'tries chromium first; Chrome is the last fallback on hosts without it'],
  ['v2/client/src/shoot/shoot.mjs', 'tries chromium first; Chrome is the last fallback on hosts without it'],
  ['apps/server/src/god/look-renderer.ts', "the world host's own renderer looks for an installed Chrome by path"],
  ['tools/god-skill/lib/remote-look.mjs', 'only checks whether Chrome is installed to pick a local or remote look'],
  ['tools/god-skill/eden-god.mjs', 'bundled copy of lib/remote-look.mjs'],
  ['tools/god-skill/lib/warm.test.mjs', 'process-list fixtures, launches nothing'],
  ['tools/floaters/preview.mjs', 'playwright-core with no browser download by design; set CHROME'],
  ['v2/tools/stream-check/run.mjs', 'spawns a browser without Playwright; PATH Chromium first, set CHROME'],
  ['v2/tools/wasm-load/browser.mjs', 'spawns a browser without Playwright; PATH Chromium first, set CHROME'],
  ['v2/web/src/hatch/hatch.browser.mjs', 'spawns a browser without Playwright; PATH Chromium first, set CHROME'],
]);
const REAL_CHROME = String.raw`channel:[[:space:]]*['"]chrome['"]|Google Chrome\.app/Contents/MacOS`; // git grep -E (POSIX: no \s)
const REAL_CHROME_JS = /channel:\s*['"]chrome['"]|Google Chrome\.app\/Contents\/MacOS/;

export function realChromeHits(cwd = root) {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', REAL_CHROME, '--', '*.mjs', '*.cjs', '*.js', '*.ts', '*.tsx', ':!**/node_modules/**'], { cwd, encoding: 'utf8' });
  } catch (e) { if (e.status !== 1) throw e; } // 1: no match
  return out.split('\n').filter(Boolean).map((line) => ({ file: line.slice(0, line.indexOf(':')), line }))
    .filter((h) => h.file !== SELF && !ALLOW.has(h.file));
}

test('no browser script launches the installed Google Chrome', () => {
  const hits = realChromeHits();
  assert.deepEqual(hits.map((h) => h.line.slice(0, 200)), [],
    "use channel: 'chromium' (Playwright's own Chromium on the hardware GPU), see docs/testing.md#browser-channel");
});

test('the allowlist names only files that still exist and still need it', () => {
  const tracked = new Set(execFileSync('git', ['ls-files', '--', ...ALLOW.keys()], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean));
  for (const file of ALLOW.keys()) {
    assert.ok(tracked.has(file), `${file} is allowlisted but no longer tracked; drop it from ALLOW`);
    assert.match(readFileSync(resolve(root, file), 'utf8'), REAL_CHROME_JS, `${file} no longer reaches real Chrome; drop it from ALLOW`);
  }
});

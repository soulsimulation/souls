#!/usr/bin/env node
// Which Chromium a release's Eyes worker would launch (#1340), checked before it goes live:
//   node tools/world-launcher/deploy/eyes-browser.mjs [--tree <release dir, default this checkout>] [--browsers <PLAYWRIGHT_BROWSERS_PATH>]
// Reads the release's own Playwright (mars/viewer's @playwright/test) for the revision it expects, then applies the worker's
// rule (apps/server/src/edge/eyes/browser-config.mjs eyesExecutable): EDGE_EYES_CHROME, else Playwright's own, else the
// newest installed chromium-<rev>. Prints one JSON line; exit 0 when Eyes has a browser, 1 when it would have none.
// Run it as the worlds' user with the launcher's eyes settings (PLAYWRIGHT_BROWSERS_PATH, EDGE_EYES_CHROME). Downloads nothing.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const tree = resolve(opt('--tree') ?? fileURLToPath(new URL('../../..', import.meta.url)));
if (opt('--browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(opt('--browsers'));
const { eyesExecutable } = await import(join(tree, 'apps/server/src/edge/eyes/browser-config.mjs'));
let expected = null, version = null, error = null;
try {
  const req = createRequire(join(tree, 'mars/viewer/package.json'));
  expected = req('@playwright/test').chromium.executablePath(); version = /chromium-(\d+)/.exec(expected)?.[1] ?? null;
} catch (e) { error = e.message.split('\n')[0]; }
const pick = error ? { path: null, problem: `the release's Playwright could not be loaded: ${error}` } : eyesExecutable(expected, process.env);
console.log(JSON.stringify({ revision: version, expected, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null, ...pick }));
process.exitCode = pick.problem ? 1 : 0;

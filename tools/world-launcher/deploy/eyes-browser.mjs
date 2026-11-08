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
for (const k of ['--tree', '--browsers']) if (a.includes(k) && !opt(k)) { console.error(`${k} needs a value`); process.exit(2); }
if (opt('--browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(opt('--browsers'));
const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.problem ? 1 : 0; };
let eyesExecutable;
try { ({ eyesExecutable } = await import(join(tree, 'apps/server/src/edge/eyes/browser-config.mjs'))); }
catch (e) { out({ tree, path: null, problem: `not a release tree: ${e.message.split('\n')[0]}` }); process.exit(); }
if (process.env.EDGE_EYES_HEADLESS_SHELL === '1' && !process.env.EDGE_EYES_CHROME) { out({ path: null, source: 'headless-shell', note: 'EDGE_EYES_HEADLESS_SHELL=1: the worker launches Playwright\'s headless shell, which this tool does not check' }); process.exit(); }
let expected = null, version = null, error = null;
try {
  // the worker resolves Playwright from EDGE_EYES_PLAYWRIGHT, else the tree's mars/viewer
  const req = createRequire(process.env.EDGE_EYES_PLAYWRIGHT ? resolve(process.env.EDGE_EYES_PLAYWRIGHT) : join(tree, 'mars/viewer/package.json'));
  expected = req('@playwright/test').chromium.executablePath(); version = /chromium-(\d+)/.exec(expected)?.[1] ?? null;
} catch (e) { error = e.message.split('\n')[0]; }
const pick = error ? { path: null, problem: `the release's Playwright could not be loaded: ${error}` } : eyesExecutable(expected, process.env);
out({ revision: version, expected, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null, ...pick });
